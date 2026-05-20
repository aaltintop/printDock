import { log } from "../lib/logger.server";
import type { OrderJob, UploadAsset, UploadSession } from "../types/printdock";
import {
  DEFAULT_FILE_RENAME_PATTERN,
  applyRenamePattern,
  sanitizeSegment,
} from "../utils/file-rename-pattern";
import { getHmacSecretFromFirestore } from "./shop-secret.server";
import {
  resolveSignedPriceTokenForSession,
  tokenRequiresFeeLine,
  verifyPriceToken,
} from "./price-token.server";
import {
  appendOrderJobAuditEvent,
  getOrderJob,
  getUploadField,
  getUploadSession,
  mergeOrderJob,
  updateUploadSession,
} from "./shop-data.server";
import {
  copyFileIfSourceExists,
  fileExists,
  isOrderStoragePath,
} from "./storage.server";
import {
  extractShortIdFromPrintReadyUrl,
  lookupShortLink,
  lookupShortLinksForStoragePaths,
  markShortLinkRepointed,
} from "./short-link.server";
import type { OrderIngestQueueItem } from "./order-ingest-queue.server";
import { completeOrderIngestItem, failOrderIngestItem, ORDER_INGEST_MAX_ATTEMPTS } from "./order-ingest-queue.server";

type LineProps = Array<{ name: string; value: string }>;

function propValue(props: LineProps, name: string): string | undefined {
  return props.find((p) => p.name === name)?.value;
}

function minimalAssetFromPath(storagePath: string, originalName: string): UploadAsset {
  const ext = originalName.includes(".") ? (originalName.split(".").pop() ?? "bin") : "bin";
  return {
    id: `recovered_${Date.now()}`,
    storagePath,
    originalName,
    mimeType: "application/octet-stream",
    fileExtension: ext,
    sizeBytes: 0,
    widthPx: null,
    heightPx: null,
    dpi: null,
    widthInch: null,
    heightInch: null,
    pageCount: null,
    validationResults: [],
    pricing: null,
    blocked: false,
  };
}

export async function resolveSessionAssetsForIngest(
  shopDomain: string,
  sessionToken: string,
  lineProps: LineProps,
): Promise<{
  assets: UploadAsset[];
  sessionData: UploadSession | null;
  recoveredFromShortLink: boolean;
} | null> {
  const sessionData = await getUploadSession(shopDomain, sessionToken);
  if (sessionData) {
    const assets =
      sessionData.assets.length > 0
        ? sessionData.assets
        : sessionData.asset
          ? [sessionData.asset]
          : [];
    if (assets.length > 0) {
      return { assets, sessionData, recoveredFromShortLink: false };
    }
  }

  const printUrl =
    propValue(lineProps, "View uploads") ??
    propValue(lineProps, "__View uploads") ??
    propValue(lineProps, "_View uploads") ??
    propValue(lineProps, "Print Ready File") ??
    propValue(lineProps, "_Print Ready File");
  const shortId = extractShortIdFromPrintReadyUrl(printUrl);
  if (!shortId) return null;

  const link = await lookupShortLink(shopDomain, shortId);
  if (!link?.storagePath) return null;

  if (!(await fileExists(link.storagePath))) {
    return null;
  }

  return {
    assets: [minimalAssetFromPath(link.storagePath, link.originalName || "artwork")],
    sessionData,
    recoveredFromShortLink: true,
  };
}

async function buildRenamedAssetForOrder({
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  shopifyLineItemId,
  lineTitle,
  lineVariantTitle,
  asset,
  pattern,
  fileIndex,
}: {
  shopDomain: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyLineItemId: string;
  lineTitle: string;
  lineVariantTitle: string;
  asset: UploadAsset;
  pattern: string;
  fileIndex: number;
}): Promise<{ asset: UploadAsset; copyResult: Awaited<ReturnType<typeof copyFileIfSourceExists>> }> {
  const extension = (asset.fileExtension || asset.originalName.split(".").pop() || "bin").toLowerCase();
  const originalNameWithoutExt = asset.originalName.replace(/\.[^/.]+$/, "");
  const tokens: Record<string, string> = {
    orderId: shopifyOrderId,
    orderName: shopifyOrderName,
    lineItemId: shopifyLineItemId,
    variantName: lineVariantTitle || lineTitle || "variant",
    originalName: originalNameWithoutExt,
    fileIndex: String(fileIndex + 1),
  };
  const renamedBase = sanitizeSegment(applyRenamePattern(pattern, tokens)) || "print_file";
  const renamedFileName = `${renamedBase}.${extension}`;
  const targetPath = `uploads/${shopDomain}/orders/${shopifyOrderId}/${renamedFileName}`;

  const copyResult = await copyFileIfSourceExists(asset.storagePath, targetPath);

  return {
    copyResult,
    asset: {
      ...asset,
      storagePath: targetPath,
      originalName: renamedFileName,
      fileExtension: extension,
    },
  };
}

async function buildPricingEvidence(
  shopDomain: string,
  sessionToken: string,
  field: Awaited<ReturnType<typeof getUploadField>>,
  priceTokenRaw: string | undefined,
  orderLineItems: Array<{ properties?: Array<{ name?: string; value?: string }> }> | undefined,
  nowUnix: number,
): Promise<OrderJob["pricingEvidence"] | undefined> {
  if (!field?.pricing?.enabled && !priceTokenRaw) return undefined;

  const hmacKey = await getHmacSecretFromFirestore(shopDomain);
  const verified =
    priceTokenRaw && hmacKey ? verifyPriceToken(String(priceTokenRaw), hmacKey, nowUnix) : null;
  const sessionOk = Boolean(
    verified && verified.shop === shopDomain && verified.sid === sessionToken,
  );

  let anomalyReason: string | undefined;
  if (field?.pricing?.enabled) {
    if (!priceTokenRaw) {
      anomalyReason = "signed_price_missing";
    } else if (!sessionOk) {
      anomalyReason = "signed_price_invalid_or_expired";
    } else if (tokenRequiresFeeLine(verified) && !orderHasFeeLineForSession(orderLineItems, sessionToken)) {
      anomalyReason = "upload_fee_line_missing";
    }
  }

  return {
    hadPriceToken: Boolean(priceTokenRaw),
    tokenValid: sessionOk,
    signedMinorPerUnit: sessionOk && verified ? verified.p : undefined,
    anomalyReason,
  };
}

function orderHasFeeLineForSession(
  lineItems: Array<{ properties?: Array<{ name?: string; value?: string }> }> | undefined,
  sessionId: string,
): boolean {
  for (const line of lineItems ?? []) {
    const props = line.properties ?? [];
    const feeFor = props.find((p) => p.name === "_pd_fee_for")?.value;
    if (String(feeFor || "").trim() === sessionId) return true;
  }
  return false;
}

/** Metadata-only copy for list/detail UI while ingest has not finished. */
export function buildIngestPreviewAsset(asset: UploadAsset): UploadAsset {
  return {
    ...asset,
    storagePath: "",
    blocked: false,
  };
}

export async function enrichJobWithIngestPreview(
  shopDomain: string,
  jobId: string,
  sessionToken: string,
  lineItemProps: LineProps,
): Promise<void> {
  const resolved = await resolveSessionAssetsForIngest(shopDomain, sessionToken, lineItemProps);
  if (!resolved?.assets[0]) return;
  await mergeOrderJob(shopDomain, jobId, {
    ingestPreviewAsset: buildIngestPreviewAsset(resolved.assets[0]),
  });
}

async function resetIngestPendingAfterRetry(shopDomain: string, jobId: string): Promise<void> {
  await mergeOrderJob(shopDomain, jobId, { ingestStatus: "pending" });
}

export async function markJobArtworkUnrecoverable(
  shopDomain: string,
  jobId: string,
  detail: string,
): Promise<void> {
  const tags = ["artwork_unrecoverable", "needs_review"];
  await mergeOrderJob(shopDomain, jobId, {
    ingestStatus: "failed",
    ingestEvidence: { anomalyReason: "artwork_unrecoverable", detail },
    status: "pending_review",
    tags,
  });
  await appendOrderJobAuditEvent(shopDomain, jobId, {
    eventType: "artwork_unrecoverable",
    message: "Paid order artwork could not be recovered from storage",
    metadata: { detail },
    actor: "system:order_ingest",
  });
  log.event("orders_create_asset_unrecoverable", { shopDomain, jobId, detail });
}

export async function processOrderIngestItem(
  queueItem: OrderIngestQueueItem,
  options?: {
    signedPriceMapBySession?: Record<string, string>;
    orderLineItems?: Array<{ properties?: Array<{ name?: string; value?: string }> }>;
    lineTitle?: string;
    lineVariantTitle?: string;
    perFileQuantity?: number;
  },
): Promise<"complete" | "failed" | "retry"> {
  const { shopDomain, jobId, sessionToken, lineItemProps: props } = queueItem;
  const shopifyOrderId = queueItem.shopifyOrderId;
  const shopifyLineItemId = queueItem.shopifyLineItemId;

  const existingJob = await getOrderJob(shopDomain, jobId);
  if (
    existingJob?.ingestStatus === "complete" &&
    existingJob.assetSnapshot &&
    isOrderStoragePath(String(existingJob.assetSnapshot.storagePath ?? ""), shopDomain) &&
    (await fileExists(String(existingJob.assetSnapshot.storagePath)))
  ) {
    await completeOrderIngestItem(shopDomain, queueItem.id);
    return "complete";
  }

  if (!existingJob) {
    await mergeOrderJob(
      shopDomain,
      jobId,
      buildPlaceholderJob({
        shopDomain,
        jobId,
        shopifyOrderId,
        shopifyOrderName: queueItem.shopifyOrderName,
        shopifyLineItemId,
        sessionToken,
        lineItemProps: props,
      }),
    );
    await enrichJobWithIngestPreview(shopDomain, jobId, sessionToken, props);
  } else {
    await mergeOrderJob(shopDomain, jobId, { ingestStatus: "processing" });
  }

  const resolved = await resolveSessionAssetsForIngest(shopDomain, sessionToken, props);
  if (!resolved) {
    if (queueItem.attempts >= ORDER_INGEST_MAX_ATTEMPTS) {
      await markJobArtworkUnrecoverable(shopDomain, jobId, "no_session_or_short_link_blob");
      await failOrderIngestItem(shopDomain, queueItem.id, "unrecoverable");
      return "failed";
    }
    await resetIngestPendingAfterRetry(shopDomain, jobId);
    return "retry";
  }

  const { assets, sessionData, recoveredFromShortLink } = resolved;
  const field = sessionData?.fieldId
    ? await getUploadField(shopDomain, sessionData.fieldId)
    : null;
  const renamePattern = field?.fileRenamingPattern || DEFAULT_FILE_RENAME_PATTERN;
  const nowUnix = Math.floor(Date.now() / 1000);
  const { token: priceTokenRaw, mapLineMismatch } = resolveSignedPriceTokenForSession(
    sessionToken,
    props,
    options?.signedPriceMapBySession,
  );
  if (mapLineMismatch) {
    log.warn("pricing_token_map_mismatch", "Legacy line __ucToken differs from cart price map", {
      sessionToken,
    });
  }
  const pricingEvidence = await buildPricingEvidence(
    shopDomain,
    sessionToken,
    field,
    priceTokenRaw,
    options?.orderLineItems,
    nowUnix,
  );

  const renamedAssets: UploadAsset[] = [];
  let anyCopyOk = false;

  for (const [assetIndex, asset] of assets.entries()) {
    const { asset: renamedAsset, copyResult } = await buildRenamedAssetForOrder({
      shopDomain,
      shopifyOrderId,
      shopifyOrderName: queueItem.shopifyOrderName,
      shopifyLineItemId,
      lineTitle: options?.lineTitle ?? "",
      lineVariantTitle: options?.lineVariantTitle ?? "",
      asset,
      pattern: renamePattern,
      fileIndex: assetIndex,
    });

    if (copyResult === "source_missing") {
      continue;
    }
    anyCopyOk = true;
    renamedAssets.push(renamedAsset);

    const legacyPath = asset.storagePath;
    const printUrl =
      propValue(props, "View uploads") ??
      propValue(props, "__View uploads") ??
      propValue(props, "_View uploads") ??
      propValue(props, "Print Ready File") ??
      propValue(props, "_Print Ready File");
    const shortId = extractShortIdFromPrintReadyUrl(printUrl);
    if (shortId) {
      try {
        await markShortLinkRepointed(shopDomain, shortId, renamedAsset.storagePath, renamedAsset.originalName, legacyPath);
        log.event("orders_create_short_link_repointed", { shopDomain, jobId, shortId });
      } catch (err) {
        log.error("orders_create_short_link_repoint_failed", err, { shopDomain, jobId, shortId });
      }
    }

    const linkMap = await lookupShortLinksForStoragePaths(shopDomain, [legacyPath]);
    const entries = linkMap.get(legacyPath) ?? [];
    for (const entry of entries) {
      if (entry.shortId === shortId) continue;
      try {
        await markShortLinkRepointed(
          shopDomain,
          entry.shortId,
          renamedAsset.storagePath,
          renamedAsset.originalName,
          legacyPath,
        );
      } catch {
        // best effort
      }
    }
  }

  if (!anyCopyOk) {
    if (queueItem.attempts >= ORDER_INGEST_MAX_ATTEMPTS) {
      await markJobArtworkUnrecoverable(shopDomain, jobId, "copy_source_missing");
      await failOrderIngestItem(shopDomain, queueItem.id, "copy_source_missing");
      return "failed";
    }
    await resetIngestPendingAfterRetry(shopDomain, jobId);
    return "retry";
  }

  const renamedAsset = renamedAssets[0];
  const perFileQuantity = options?.perFileQuantity ?? 1;
  const fileUnitPrice = Number(
    renamedAsset.pricing?.filePrice != null
      ? renamedAsset.pricing.filePrice
      : renamedAsset.pricing?.total || 0,
  );
  const calculatedPrice = Math.round(fileUnitPrice * Math.max(1, perFileQuantity) * 100) / 100;

  const tags: string[] = ["ingest_complete"];
  if (assets.length > 1) tags.push("multi_file");
  if (renamedAsset.blocked) tags.push("blocked_asset");
  if (renamedAsset.validationResults.some((r) => r.severity === "warning")) tags.push("needs_review");
  if (pricingEvidence?.anomalyReason) tags.push("pricing_anomaly");
  if (recoveredFromShortLink) tags.push("recovered_metadata_incomplete");

  const hasWarningOrBlocker =
    renamedAsset.blocked ||
    renamedAsset.validationResults.some(
      (r) => r.severity === "warning" || r.severity === "blocking",
    );
  const status = hasWarningOrBlocker ? "pending_review" : "uploaded";

  await mergeOrderJob(shopDomain, jobId, {
    assetSnapshot: renamedAsset,
    ingestPreviewAsset: null,
    legacySessionUploadPath: assets[0]?.storagePath,
    productId: sessionData?.productId ?? "",
    variantId: sessionData?.variantId ?? "",
    calculatedPrice,
    pricingEvidence,
    warnings: renamedAsset.validationResults
      .filter((r) => r.severity === "warning")
      .map((r) => r.message),
    status,
    tags,
    ingestStatus: "complete",
    ingestEvidence: recoveredFromShortLink
      ? { recoveredFromShortLink: true }
      : undefined,
  });

  if (recoveredFromShortLink) {
    log.event("orders_create_asset_recovered_from_short_link", { shopDomain, jobId });
    await appendOrderJobAuditEvent(shopDomain, jobId, {
      eventType: "asset_recovered_from_short_link",
      message: "Artwork recovered via Print Ready short link after session was missing",
      metadata: {},
      actor: "system:order_ingest",
    });
  }

  if (sessionData) {
    await updateUploadSession(shopDomain, sessionToken, {
      asset: renamedAssets[0] ?? sessionData.asset,
      assets: renamedAssets.length > 0 ? renamedAssets : sessionData.assets,
      status: "converted",
    });
  }

  await appendOrderJobAuditEvent(shopDomain, jobId, {
    eventType: "ingest_complete",
    message: `Order ingest completed with status "${status}"`,
    metadata: { orderId: shopifyOrderId, lineItemId: shopifyLineItemId },
    actor: "system:order_ingest",
  });

  await completeOrderIngestItem(shopDomain, queueItem.id);
  return "complete";
}

export function buildPlaceholderJob(params: {
  shopDomain: string;
  jobId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyLineItemId: string;
  sessionToken: string;
  lineItemProps: LineProps;
}): Partial<OrderJob> {
  const nowIso = new Date().toISOString();
  return {
    id: params.jobId,
    shopDomain: params.shopDomain,
    shopifyOrderId: params.shopifyOrderId,
    shopifyOrderName: params.shopifyOrderName,
    shopifyLineItemId: params.shopifyLineItemId,
    sessionId: params.sessionToken,
    lineItemPropsSnapshot: params.lineItemProps,
    assetSnapshot: null,
    shippingAddress: null,
    productId: "",
    variantId: "",
    calculatedPrice: 0,
    warnings: [],
    status: "uploaded",
    assignee: null,
    internalNotes: "",
    tags: ["ingest_pending"],
    ingestStatus: "pending",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
