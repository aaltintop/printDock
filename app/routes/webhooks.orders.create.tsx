import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import {
  appendOrderJobAuditEvent,
  getUploadField,
  getUploadSession,
  jobsCollection,
  saveOrderJob,
  updateUploadSession,
} from "../services/shop-data.server";
import { copyFile } from "../services/storage.server";
import type { OrderJob } from "../types/printdock";
import {
  DEFAULT_FILE_RENAME_PATTERN,
  applyRenamePattern,
  sanitizeSegment,
} from "../utils/file-rename-pattern";
import { getHmacSecretFromFirestore } from "../services/shop-secret.server";
import { verifyPriceToken } from "../services/price-token.server";

type OrderLineProperty = {
  name?: string;
  value?: string;
};

type OrdersCreateLine = {
  id?: string | number;
  quantity?: number;
  variant_title?: string;
  title?: string;
  properties?: OrderLineProperty[];
};

type OrdersCreatePayload = {
  id?: string | number;
  name?: string;
  line_items?: OrdersCreateLine[];
  note_attributes?: OrderLineProperty[];
};

type PriceMapEntry = {
  sid?: string;
  token?: string;
};

function priceMapFromCartAttributeJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw)) as PriceMapEntry[];
    if (!Array.isArray(parsed)) return {};
    return parsed.reduce(
      (acc: Record<string, string>, entry) => {
        const sid = String(entry?.sid || "").trim();
        const token = String(entry?.token || "").trim();
        if (!sid || !token) return acc;
        acc[sid] = token;
        return acc;
      },
      {} as Record<string, string>,
    );
  } catch {
    return {};
  }
}

function parseSignedPriceMap(noteAttributes: OrderLineProperty[] | undefined): Record<string, string> {
  const legacy = priceMapFromCartAttributeJson(noteAttributes?.find((attr) => attr.name === "__pd_price_map")?.value);
  const primary = priceMapFromCartAttributeJson(noteAttributes?.find((attr) => attr.name === "_pd_price_map")?.value);
  return { ...legacy, ...primary };
}

async function buildRenamedAsset({
  shopDomain,
  order,
  line,
  asset,
  pattern,
  fileIndex,
}: {
  shopDomain: string;
  order: OrdersCreatePayload;
  line: OrdersCreateLine;
  asset: NonNullable<OrderJob["assetSnapshot"]>;
  pattern: string;
  fileIndex: number;
}) {
  const extension = (asset.fileExtension || asset.originalName.split(".").pop() || "bin").toLowerCase();
  const originalNameWithoutExt = asset.originalName.replace(/\.[^/.]+$/, "");
  const tokens: Record<string, string> = {
    orderId: String(order.id),
    orderName: String(order.name || ""),
    lineItemId: String(line.id),
    variantName: String(line.variant_title || line.title || "variant"),
    originalName: originalNameWithoutExt,
    fileIndex: String(fileIndex + 1),
  };
  const renamedBase = sanitizeSegment(applyRenamePattern(pattern, tokens)) || "print_file";
  const renamedFileName = `${renamedBase}.${extension}`;
  const targetPath = `uploads/${shopDomain}/orders/${order.id}/${renamedFileName}`;

  if (asset.storagePath !== targetPath) {
    await copyFile(asset.storagePath, targetPath);
    // Do not delete the session upload: line item "Print Ready" links embed a signed
    // token for this path; deleting here breaks download with GCS NoSuchKey.
  }

  return {
    ...asset,
    storagePath: targetPath,
    originalName: renamedFileName,
    fileExtension: extension,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      // authenticate.webhook handles HMAC verification automatically
      const { topic, shop, payload } = await authenticate.webhook(request);

      if (topic !== "ORDERS_CREATE") {
        return new Response("Ignored", { status: 200 });
      }

      const order = payload as OrdersCreatePayload;
      const shopDomain = shop;
      setLogShopDomain(shopDomain);
      log.event("webhook_received", { topic, shopDomain });
      log.event("orders_create_received", {
        shopDomain,
        orderId: String(order.id),
        lineItemCount: Array.isArray(order.line_items) ? order.line_items.length : 0,
      });

      const hmacKey = await getHmacSecretFromFirestore(shopDomain);
      const nowUnix = Math.floor(Date.now() / 1000);
      const signedPriceMapBySession = parseSignedPriceMap(order.note_attributes);

      // Process each line item
      for (const line of order.line_items ?? []) {
        const props = line.properties ?? [];
        const sessionToken = props.find((p) => p.name === "_uc_session")?.value;
        if (!sessionToken) {
          const hasPrintDockHints = props.some((p) =>
            [
              "_pd_session",
              "__ucToken",
              "_Artwork",
              "Artwork",
              "Print Ready File",
            ].includes(String(p?.name || "")),
          );
          if (hasPrintDockHints) {
            log.warn("orders_create_missing_uc_session", "PrintDock hints without session token", {
              shopDomain,
              orderId: String(order.id),
              lineItemId: String(line.id),
              propertyNames: props.map((p) => String(p?.name || "")).slice(0, 20),
            });
          }
          continue;
        }

        // Find the session
        const sessionData = await getUploadSession(shopDomain, String(sessionToken));
        if (!sessionData || !sessionData.asset) {
          log.warn("orders_create_session_not_found", "Upload session missing for line item", {
            shopDomain,
            orderId: String(order.id),
            lineItemId: String(line.id),
            sessionToken: String(sessionToken),
          });
          continue;
        }
        const sessionAssets = sessionData.assets.length > 0 ? sessionData.assets : [sessionData.asset];

        const field = sessionData.fieldId ? await getUploadField(shopDomain, sessionData.fieldId) : null;
        const renamePattern = field?.fileRenamingPattern || DEFAULT_FILE_RENAME_PATTERN;

        const priceTokenRaw = signedPriceMapBySession[String(sessionToken)];
        let pricingEvidence: OrderJob["pricingEvidence"] | undefined;
        if (field?.pricing?.enabled || priceTokenRaw) {
          const verified =
            priceTokenRaw && hmacKey
              ? verifyPriceToken(String(priceTokenRaw), hmacKey, nowUnix)
              : null;
          const sessionOk = Boolean(
            verified &&
            verified.shop === shopDomain &&
            verified.sid === String(sessionToken),
          );
          let anomalyReason: string | undefined;
          if (field?.pricing?.enabled) {
            if (!priceTokenRaw) {
              anomalyReason = "signed_price_missing";
            } else if (!sessionOk) {
              anomalyReason = "signed_price_invalid_or_expired";
            }
          }
          pricingEvidence = {
            hadPriceToken: Boolean(priceTokenRaw),
            tokenValid: sessionOk,
            signedMinorPerUnit: sessionOk && verified ? verified.p : undefined,
            anomalyReason,
          };
        }

        const renamedAssets = [];

        for (const [assetIndex, asset] of sessionAssets.entries()) {
          const jobId = `${order.id}_${line.id}_${asset.id || assetIndex}`;
          const existingJobDoc = await jobsCollection(shopDomain).doc(jobId).get();
          if (existingJobDoc.exists) {
            log.event("orders_create_duplicate_job_skipped", {
              shopDomain,
              orderId: String(order.id),
              lineItemId: String(line.id),
              jobId,
            });
            continue;
          }

          const renamedAsset = await buildRenamedAsset({
            shopDomain,
            order,
            line,
            asset,
            pattern: renamePattern,
            fileIndex: assetIndex,
          });
          renamedAssets.push(renamedAsset);

          const nowIso = new Date().toISOString();
          const perFileQuantity = Number(line.quantity || 1);
          const fileUnitPrice = Number(
            renamedAsset.pricing?.filePrice != null
              ? renamedAsset.pricing.filePrice
              : renamedAsset.pricing?.total || 0,
          );
          const calculatedPrice = Math.round(fileUnitPrice * Math.max(1, perFileQuantity) * 100) / 100;
          const assignee = null;
          const tags = [];
          if (sessionAssets.length > 1) tags.push("multi_file");
          if (renamedAsset.blocked) tags.push("blocked_asset");
          if (renamedAsset.validationResults.some((result) => result.severity === "warning")) {
            tags.push("needs_review");
          }
          if ((renamedAsset.widthInch || 0) > 20 || (renamedAsset.heightInch || 0) > 20) {
            tags.push("large_format");
          }
          if (pricingEvidence?.anomalyReason) {
            tags.push("pricing_anomaly");
          }
          const hasWarningOrBlocker =
            renamedAsset.blocked ||
            renamedAsset.validationResults.some(
              (result) => result.severity === "warning" || result.severity === "blocking",
            );
          const initialStatus = hasWarningOrBlocker ? "pending_review" : "uploaded";

          const job: OrderJob = {
            id: jobId,
            shopDomain,
            shopifyOrderId: String(order.id),
            shopifyOrderName: String(order.name ?? ""),
            shopifyLineItemId: String(line.id),
            sessionId: String(sessionToken),
            legacySessionUploadPath: asset.storagePath,
            shippingAddress: null,
            productId: sessionData.productId,
            variantId: sessionData.variantId,
            assetSnapshot: renamedAsset,
            lineItemPropsSnapshot: Array.isArray(props)
              ? props.map((prop) => ({
                name: String(prop.name ?? ""),
                value: String(prop.value ?? ""),
              }))
              : [],
            calculatedPrice,
            pricingEvidence,
            warnings: renamedAsset.validationResults
              .filter((result) => result.severity === "warning")
              .map((result) => result.message),
            status: initialStatus,
            assignee,
            internalNotes: "",
            tags,
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          await saveOrderJob(shopDomain, job);
          await appendOrderJobAuditEvent(shopDomain, jobId, {
            eventType: "job_created",
            message: `Order job created with status "${job.status}"`,
            metadata: {
              orderId: job.shopifyOrderId,
              lineItemId: job.shopifyLineItemId,
              tags: job.tags,
              calculatedPrice: job.calculatedPrice,
            },
            actor: "system:webhook",
          });
        }

        // Mark session as converted
        await updateUploadSession(shopDomain, String(sessionToken), {
          asset: renamedAssets[0] || sessionData.asset,
          assets: renamedAssets.length > 0 ? renamedAssets : sessionAssets,
          status: "converted",
        });
      }

      log.event("webhook_processed", { topic: "ORDERS_CREATE", shopDomain });
      return new Response("OK", { status: 200 });
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("webhook_orders_create_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
}
