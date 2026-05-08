import { data } from "react-router";
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
import { extractMetadata, runValidationRules, hasBlockingError } from "../services/validation.server";
import { calculatePrice } from "../services/pricing.server";
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
import type { ValidationResult, ValidationRule } from "../services/validation.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function isSafeSessionStoragePath(path: string, shopDomain: string): boolean {
  const prefix = `uploads/${shopDomain}/`;
  return path.startsWith(prefix) && !path.includes("..");
}

type SupportedDimensionType = "widthInch" | "heightInch" | "dpi";
type DimensionRuleMeta = {
  groupId: string;
  dimensionType: SupportedDimensionType;
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  value: number;
};

function isSupportedDimensionType(value: string): value is SupportedDimensionType {
  return value === "widthInch" || value === "heightInch" || value === "dpi";
}

function formatDimensionValue(dimensionType: SupportedDimensionType, value: number): string {
  if (dimensionType === "dpi") return String(Math.round(value));
  return value.toFixed(2);
}

function dimensionDisplayName(dimensionType: SupportedDimensionType): string {
  if (dimensionType === "widthInch") return "Width";
  if (dimensionType === "heightInch") return "Height";
  return "DPI";
}

function dimensionUnit(dimensionType: SupportedDimensionType): string {
  return dimensionType === "dpi" ? "DPI" : "in";
}

function consolidateDimensionRuleResults(
  results: ValidationResult[],
  metaByRuleId: Map<string, DimensionRuleMeta>,
): ValidationResult[] {
  const passthrough: ValidationResult[] = [];
  const grouped = new Map<string, ValidationResult[]>();

  for (const result of results) {
    const meta = metaByRuleId.get(result.ruleId);
    if (!meta || result.severity !== "blocking") {
      passthrough.push(result);
      continue;
    }

    const key = `${meta.dimensionType}:${meta.groupId}`;
    const existing = grouped.get(key) ?? [];
    existing.push(result);
    grouped.set(key, existing);
  }

  for (const [key, groupResults] of grouped) {
    const firstMeta = metaByRuleId.get(groupResults[0]!.ruleId);
    if (!firstMeta) {
      passthrough.push(...groupResults);
      continue;
    }

    const dimensionType = firstMeta.dimensionType;
    const metas = groupResults
      .map((result) => metaByRuleId.get(result.ruleId))
      .filter((meta): meta is DimensionRuleMeta => Boolean(meta));

    const lowerBoundCandidates = metas
      .filter((meta) => meta.operator === "gte" || meta.operator === "gt")
      .map((meta) => meta.value);
    const upperBoundCandidates = metas
      .filter((meta) => meta.operator === "lte" || meta.operator === "lt")
      .map((meta) => meta.value);
    const eqCandidate = metas.find((meta) => meta.operator === "eq")?.value ?? null;
    const lowerBound = lowerBoundCandidates.length > 0 ? Math.max(...lowerBoundCandidates) : null;
    const upperBound = upperBoundCandidates.length > 0 ? Math.min(...upperBoundCandidates) : null;
    const actual =
      groupResults.find((result) => typeof result.actual === "number")?.actual ?? groupResults[0]?.actual ?? null;

    if (actual === null) {
      passthrough.push(...groupResults);
      continue;
    }

    const label = dimensionDisplayName(dimensionType);
    const unit = dimensionUnit(dimensionType);
    const actualValue = formatDimensionValue(dimensionType, actual);
    let message = `${label} does not meet the configured rule.`;
    let expected = groupResults[0]?.expected ?? 0;

    if (eqCandidate !== null) {
      message = `${label} must be exactly ${formatDimensionValue(dimensionType, eqCandidate)} ${unit}. Your file is ${actualValue} ${unit}.`;
      expected = eqCandidate;
    } else if (lowerBound !== null && upperBound !== null) {
      if (lowerBound === upperBound) {
        message = `${label} must be exactly ${formatDimensionValue(dimensionType, lowerBound)} ${unit}. Your file is ${actualValue} ${unit}.`;
        expected = lowerBound;
      } else {
        message = `${label} must be between ${formatDimensionValue(dimensionType, lowerBound)} ${unit} and ${formatDimensionValue(dimensionType, upperBound)} ${unit}. Your file is ${actualValue} ${unit}.`;
        expected = lowerBound;
      }
    } else if (lowerBound !== null) {
      message = `${label} must be at least ${formatDimensionValue(dimensionType, lowerBound)} ${unit}. Your file is ${actualValue} ${unit}.`;
      expected = lowerBound;
    } else if (upperBound !== null) {
      message = `${label} must be at most ${formatDimensionValue(dimensionType, upperBound)} ${unit}. Your file is ${actualValue} ${unit}.`;
      expected = upperBound;
    } else {
      passthrough.push(...groupResults);
      continue;
    }

    passthrough.push({
      ruleId: key,
      severity: "blocking",
      message,
      actual,
      expected,
    });
  }

  return passthrough;
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
        return data({ error: "Unauthorized" }, { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) return data({ error: "Invalid input" }, { status: 400 });

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
        return data({ error: "Invalid storage path" }, { status: 403 });
      }

      // Find session
      const sessionData = await getUploadSession(shopDomain, sessionToken);
      if (!sessionData) return data({ error: "Session not found" }, { status: 404 });
      const billingPlan = await getEffectiveBillingPlan(shopDomain);

      if (
        sessionData.status === "expired" ||
        new Date(sessionData.expiresAt).getTime() < Date.now()
      ) {
        return data({ error: "Session expired" }, { status: 410 });
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
        return data(
          {
            error: "storage_cap_exceeded",
            message: "Storage limit reached for this shop.",
            currentBytes: adjustedBytes,
            maxBytes: planLimits.maxTotalStorageBytes,
            suggestedPlan: suggestUpgradeFor(reason),
          },
          { status: 402 },
        );
      }

      // Get file from Storage for server-side validation only
      const buffer = await getFileBuffer(storagePath);

      // Extract metadata with sharp / pdf-lib
      const { metadata, actualMimeType, error } = await extractMetadata(
        buffer,
        mimeType,
        sizeBytes,
      );

      if (error) {
        return data({ error }, { status: 400 });
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
        return data(
          { error: `File exceeds plan limit of ${allowedMaxFileMB}MB` },
          { status: 402 },
        );
      }

      if (field && field.maxFiles > 1 && sessionData.assets.length >= field.maxFiles) {
        return data(
          { error: `Maximum file count reached (${field.maxFiles})` },
          { status: 400 },
        );
      }

      const dimensionRuleMetaById = new Map<string, DimensionRuleMeta>();
      const rules: ValidationRule[] = (field?.dimensionRules ?? [])
        .filter(() => canUseFeature(billingPlan.planCode, "advancedValidation"))
        .map((rule) => {
          const normalizedId = rule.id || crypto.randomUUID();
          if (isSupportedDimensionType(rule.dimensionType)) {
            dimensionRuleMetaById.set(normalizedId, {
              groupId: rule.groupId || normalizedId,
              dimensionType: rule.dimensionType,
              operator: rule.operator,
              value: Number(rule.value),
            });
          }
          return {
            id: normalizedId,
            type: rule.dimensionType,
            operator: rule.operator,
            value: rule.value,
            action: rule.action === "prevent" ? "blocking" : "warning",
            message: rule.warningMessage,
          };
        });

      let validationResults = runValidationRules(metadata, rules);
      validationResults = consolidateDimensionRuleResults(validationResults, dimensionRuleMetaById);
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
        const priceResult = calculatePrice(
          metadata,
          {
            mode: field.pricing.unitType,
            unitPrice: field.pricing.unitPrice ?? 0,
            minPrice: field.pricing.minPrice ?? 0,
            roundingEnabled: field.pricing.roundingEnabled,
          },
          quantity,
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
      log.error("upload_confirm_failed", err, {});
      return data(
        { error: "Upload confirmation failed", detail: String(err) },
        { status: 500 },
      );
    }
  });
}
