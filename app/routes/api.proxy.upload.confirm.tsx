import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import {
  canUseFeature,
  getPlan,
  isWithinTotalStorage,
  storageOverageUpgradeReason,
  suggestUpgradeFor,
} from "../config/plans";
import { createPrintReadyFileToken } from "../services/file-download-token.server";
import { deleteFile, getFileBuffer } from "../services/storage.server";
import { extractMetadata, hasBlockingError } from "../services/validation.server";
import { calculatePrice } from "../services/pricing.server";
import { ensureFeeProductForShop, inferCurrencyDecimals } from "../services/fee-product.server";
import { buildDimensionRuleMessages } from "../services/dimension-rule-message";
import type { DimensionRuleInput } from "../services/dimension-rule-message";
import { authenticate } from "../shopify.server";
import {
  adjustShopStorageUsageBytes,
  billableBytesForStoragePath,
  createCollectionIdResolver,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
  getShopStorageUsageBytes,
  getUploadField,
  getUploadSession,
  isBillableStorageAsset,
  updateUploadSession,
} from "../services/shop-data.server";
import type { UploadAsset } from "../types/printdock";
import type { ValidationResult } from "../services/validation.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";
import { data } from "react-router";

function isSafeSessionStoragePath(path: string, shopDomain: string): boolean {
  const prefix = `uploads/${shopDomain}/`;
  return path.startsWith(prefix) && !path.includes("..");
}

const schema = z.object({
  sessionToken: z.string(),
  storagePath: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  quantity: z.number().int().min(1).optional().default(1),
});

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) {
        return publicError("unauthorized", { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) return publicError("bad_request", { status: 400 });

      const { sessionToken, storagePath, originalName, mimeType, sizeBytes, quantity } =
        parsed.data;

      log.event("upload_confirm_requested", {
        sessionToken,
        storagePath,
        originalName,
        sizeBytes,
        quantity,
      });

      // Verify S3 object key isolation to prevent arbitrary file access
      if (!storagePath.startsWith(`uploads/${shopDomain}/${sessionToken}/`)) {
        return publicError("forbidden", { status: 403 });
      }

      // Find session
      const sessionData = await getUploadSession(shopDomain, sessionToken);
      if (!sessionData) return publicError("session_invalid", { status: 404 });
      const billingPlan = await getEffectiveBillingPlan(shopDomain);

      if (
        sessionData.status === "expired" ||
        new Date(sessionData.expiresAt).getTime() < Date.now()
      ) {
        return publicError("session_expired", { status: 410 });
      }

      const bytesFreed = billableBytesForStoragePath(sessionData, storagePath);
      const shopTotalBytes = await getShopStorageUsageBytes(shopDomain);
      const adjustedBytes = shopTotalBytes - bytesFreed;
      if (!isWithinTotalStorage(billingPlan.planCode, adjustedBytes, sizeBytes)) {
        const planLimits = getPlan(billingPlan.planCode);
        const reason = storageOverageUpgradeReason(billingPlan.planCode);
        log.event("upload_blocked_total_storage", {
          shopDomain,
          planCode: billingPlan.planCode,
          currentBytes: adjustedBytes,
          maxBytes: planLimits.maxTotalStorageBytes,
          requestedBytes: sizeBytes,
          fieldId: sessionData.fieldId ?? "",
        });
        return publicError("storage_cap_exceeded", {
          status: 402,
          extras: {
            currentBytes: adjustedBytes,
            maxBytes: planLimits.maxTotalStorageBytes,
            suggestedPlan: suggestUpgradeFor(reason),
          },
        });
      }

      // Get file from Storage for server-side validation only
      const buffer = await getFileBuffer(storagePath);

      // Extract metadata with sharp / pdf-lib. The raw underlying error
      // (e.g. "VipsJpeg: premature end of JPEG image") is logged but never
      // sent to the shopper — they get a friendly, actionable message.
      const { metadata, actualMimeType, errorCode, rawError } = await extractMetadata(
        buffer,
        mimeType,
        sizeBytes,
      );

      if (errorCode === "file_too_large_global") {
        return publicError("file_too_large_global", { status: 400 });
      }
      if (errorCode === "file_unreadable") {
        log.warn("upload_confirm_file_unreadable", "File could not be parsed", {
          storagePath,
          mimeType,
          rawError,
        });
        return publicError("file_unreadable", { status: 400 });
      }

      const field =
        (sessionData.fieldId ? await getUploadField(shopDomain, sessionData.fieldId) : null) ??
        (await getActiveFieldForProduct(
          shopDomain,
          sessionData.productId,
          sessionData.variantId,
          createCollectionIdResolver(),
        ));
      const planLimits = getPlan(billingPlan.planCode);
      const planMaxMB = Math.floor(planLimits.maxFileSizeBytes / (1024 * 1024));
      const allowedMaxFileMB = Math.min(field?.maxFileMB ?? Infinity, planMaxMB);
      if (Number.isFinite(allowedMaxFileMB) && sizeBytes > allowedMaxFileMB * 1024 * 1024) {
        return publicError("file_too_large", {
          status: 402,
          message: `This file is too large. Maximum allowed: ${allowedMaxFileMB}MB.`,
        });
      }

      if (field && field.maxFiles > 1 && sessionData.assets.length >= field.maxFiles) {
        return publicError("max_files", {
          status: 400,
          message: `You've reached the maximum of ${field.maxFiles} file(s) for this upload.`,
        });
      }

      const dimensionRules: DimensionRuleInput[] = canUseFeature(
        billingPlan.planCode,
        "advancedValidation",
      )
        ? (field?.dimensionRules ?? []).map((rule) => ({
            id: rule.id || crypto.randomUUID(),
            groupId: rule.groupId,
            dimensionType: rule.dimensionType,
            operator: rule.operator,
            value: Number(rule.value),
            action: rule.action,
          }))
        : [];

      const validationResults: ValidationResult[] = buildDimensionRuleMessages(
        dimensionRules,
        metadata,
      );
      const extension = originalName.split(".").pop()?.toLowerCase() ?? "";

      if (field?.allowedExtensions?.length && !field.allowedExtensions.includes(extension)) {
        validationResults.push({
          ruleId: "allowed_extensions",
          severity: "blocking",
          message: `File extension .${extension || "unknown"} is not allowed`,
          actual: null,
          expected: 0,
        });
      }

      if (field?.maxFileMB && sizeBytes > field.maxFileMB * 1024 * 1024) {
        validationResults.push({
          ruleId: "max_file_mb",
          severity: "blocking",
          message: `File exceeds maximum size of ${field.maxFileMB}MB`,
          actual: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
          expected: field.maxFileMB,
        });
      }

      const blocked = hasBlockingError(validationResults);

      const planAllowsDynamicPricing = canUseFeature(billingPlan.planCode, "dynamicPricing");

      // Calculate price
      let pricing = null;
      if (planAllowsDynamicPricing && field?.pricing?.enabled && !blocked) {
        const feeConfig = await ensureFeeProductForShop(shopDomain).catch(() => null);
        const currencyCode = feeConfig?.currencyCode ?? "USD";
        const currencyDecimals =
          feeConfig?.currencyDecimals ?? inferCurrencyDecimals(currencyCode);
        const priceResult = calculatePrice(
          metadata,
          {
            mode: field.pricing.unitType,
            unitPrice: field.pricing.unitPrice ?? 0,
            minPrice: field.pricing.minPrice ?? 0,
            roundingEnabled: field.pricing.roundingEnabled,
          },
          quantity,
          currencyCode,
          currencyDecimals,
        );
        if (priceResult.error) {
          // Pricing needs dimensions that the file does not carry, or the merchant has
          // misconfigured unit price. Block add-to-cart with a clear message
          // instead of silently pricing the line at $0.
          validationResults.push({
            ruleId: `pricing_${priceResult.error}`,
            severity: "blocking",
            message: priceResult.explanation,
            actual: null,
            expected: 0,
          });
          pricing = null;
        } else {
          pricing = priceResult;
        }
      }

      // Recompute `blocked` in case pricing pushed a blocking result above.
      const finalBlocked = hasBlockingError(validationResults);

      const asset: UploadAsset = {
        id: `asset_${Date.now()}`,
        storagePath,
        originalName,
        mimeType: actualMimeType,
        fileExtension: originalName.split(".").pop() ?? "",
        sizeBytes,
        widthPx: metadata.widthPx,
        heightPx: metadata.heightPx,
        dpi: metadata.dpi,
        widthInch: metadata.widthInch,
        heightInch: metadata.heightInch,
        pageCount: metadata.pageCount,
        validationResults,
        pricing,
        blocked: finalBlocked,
      };

      // For single-file fields, a new confirm replaces the prior file in-session.
      // Delete superseded blob to avoid Storage cost growth from repeated retries/re-uploads.
      const isSingleFileField = (field?.maxFiles ?? 1) <= 1;
      const supersededAssets = isSingleFileField
        ? sessionData.assets.filter((existingAsset) => existingAsset.storagePath !== asset.storagePath)
        : [];
      let supersededBytesFreed = 0;
      for (const oldAsset of supersededAssets) {
        const oldPath = String(oldAsset.storagePath ?? "").trim();
        if (!oldPath || !isSafeSessionStoragePath(oldPath, shopDomain)) continue;
        try {
          await deleteFile(oldPath);
          if (isBillableStorageAsset(oldAsset)) {
            supersededBytesFreed += Number(oldAsset.sizeBytes) || 0;
          }
        } catch (cleanupErr) {
          log.error("upload_confirm_superseded_cleanup_failed", cleanupErr, {
            sessionToken,
            oldPath,
          });
        }
      }

      const previousAssets = isSingleFileField
        ? []
        : sessionData.assets.filter((existingAsset) => existingAsset.storagePath !== asset.storagePath);
      const updatedAssets = [...previousAssets, asset];
      const sessionBlocked = updatedAssets.some((entry) => entry.blocked);

      await updateUploadSession(shopDomain, sessionToken, {
        asset: updatedAssets[updatedAssets.length - 1] ?? asset,
        assets: updatedAssets,
        status: sessionBlocked ? "blocked" : "success",
      });

      // Maintain the running shop-level storage counter:
      // + new asset bytes
      // − bytes for the prior asset at the same storagePath (overwrite)
      // − bytes for any superseded assets we just deleted (single-file replace)
      const counterDelta = sizeBytes - bytesFreed - supersededBytesFreed;
      if (counterDelta !== 0) {
        await adjustShopStorageUsageBytes(shopDomain, counterDelta);
      }

      const downloadSecret = process.env.SHOPIFY_API_SECRET || "";
      const printReadyToken = createPrintReadyFileToken(
        shopDomain,
        storagePath,
        originalName,
        downloadSecret,
      );
      const printReadyFileUrl =
        !finalBlocked && printReadyToken
          ? `https://${shopDomain}/apps/printdock/api/proxy/upload/file?token=${encodeURIComponent(printReadyToken)}`
          : null;

      if (finalBlocked || sessionBlocked) {
        log.event("upload_blocked", {
          sessionToken,
          storagePath,
          blocked: finalBlocked,
          sessionBlocked,
          assetsCount: updatedAssets.length,
        });
      } else {
        log.event("upload_confirmed", {
          sessionToken,
          storagePath,
          assetsCount: updatedAssets.length,
        });
      }

      return data({
        asset,
        metadata,
        validationResults,
        blocked: finalBlocked,
        pricing,
        assetsCount: updatedAssets.length,
        sessionBlocked,
        printReadyFileUrl,
      });
    } catch (err) {
      return internalError("upload_confirm_failed", err);
    }
  });
}
