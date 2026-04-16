import type { ActionFunctionArgs } from "react-router";
import { processBillableOrder } from "../services/billing.server";
import { authenticate } from "../shopify.server";
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

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function applyRenamePattern(pattern: string, tokens: Record<string, string>): string {
  return pattern.replace(/\{([^}]+)\}/g, (_, token: string) => {
    const key = token.trim();
    return tokens[key] ?? "";
  });
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
  order: any;
  line: any;
  asset: NonNullable<OrderJob["assetSnapshot"]>;
  pattern: string;
  fileIndex: number;
}) {
  const extension = (asset.fileExtension || asset.originalName.split(".").pop() || "bin").toLowerCase();
  const originalNameWithoutExt = asset.originalName.replace(/\.[^/.]+$/, "");
  const tokens = {
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

function parsePerFileQuantities(lineProperties: any[]): Record<string, number> {
  const quantityProp = lineProperties.find((prop: any) => prop.name === "_pd_file_quantities");
  if (!quantityProp || !quantityProp.value) return {};

  try {
    const parsed = JSON.parse(String(quantityProp.value));
    if (!Array.isArray(parsed)) return {};

    return parsed.reduce((acc: Record<string, number>, item: any) => {
      const fileName = String(item.fileName || "");
      const quantity = Number(item.quantity || 1);
      if (!fileName) return acc;
      acc[fileName] = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      return acc;
    }, {});
  } catch (error) {
    return {};
  }
}

export async function action({ request }: ActionFunctionArgs) {
  // authenticate.webhook handles HMAC verification automatically
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Ignored", { status: 200 });
  }

  const order = payload as any;
  const shopDomain = shop;
  console.info(
    JSON.stringify({
      event: "orders_create_received",
      shopDomain,
      orderId: String(order.id),
      lineItemCount: Array.isArray(order.line_items) ? order.line_items.length : 0,
    }),
  );

  // Process each line item
  for (const line of order.line_items ?? []) {
    const props = line.properties ?? [];
    const sessionToken = props.find((p: any) => p.name === "_uc_session")?.value;
    if (!sessionToken) {
      const hasPrintDockHints = props.some((p: any) =>
        [
          "_pd_session",
          "_pd_asset_ids",
          "_pd_asset_count",
          "Artwork",
          "_Artwork",
          "_Print Ready File",
          "_View uploads",
          "__ucToken",
        ].includes(String(p?.name || "")),
      );
      if (hasPrintDockHints) {
        console.warn(
          JSON.stringify({
            event: "orders_create_missing_uc_session",
            shopDomain,
            orderId: String(order.id),
            lineItemId: String(line.id),
            propertyNames: props.map((p: any) => String(p?.name || "")).slice(0, 20),
          }),
        );
      }
      continue;
    }

    // Find the session
    const sessionData = await getUploadSession(shopDomain, String(sessionToken));
    if (!sessionData || !sessionData.asset) {
      console.warn(
        JSON.stringify({
          event: "orders_create_session_not_found",
          shopDomain,
          orderId: String(order.id),
          lineItemId: String(line.id),
          sessionToken: String(sessionToken),
        }),
      );
      continue;
    }
    const sessionAssets = sessionData.assets.length > 0 ? sessionData.assets : [sessionData.asset];
    const perFileQuantities = parsePerFileQuantities(props);

    const field = sessionData.fieldId ? await getUploadField(shopDomain, sessionData.fieldId) : null;
    const renamePattern = field?.fileRenamingPattern || "{orderId}_{lineItemId}_{originalName}";
    const renamedAssets = [];

    for (const [assetIndex, asset] of sessionAssets.entries()) {
      const jobId = `${order.id}_${line.id}_${asset.id || assetIndex}`;
      const existingJobDoc = await jobsCollection(shopDomain).doc(jobId).get();
      if (existingJobDoc.exists) {
        console.info(
          JSON.stringify({
            event: "orders_create_duplicate_job_skipped",
            shopDomain,
            orderId: String(order.id),
            lineItemId: String(line.id),
            jobId,
          }),
        );
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
      const perFileQuantity =
        perFileQuantities[asset.originalName] ??
        perFileQuantities[renamedAsset.originalName] ??
        Number(line.quantity || 1);
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
          ? props.map((prop: any) => ({
              name: String(prop.name ?? ""),
              value: String(prop.value ?? ""),
            }))
          : [],
        calculatedPrice,
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

  // Process billing
  await processBillableOrder(shopDomain, order);

  return new Response("OK", { status: 200 });
}
