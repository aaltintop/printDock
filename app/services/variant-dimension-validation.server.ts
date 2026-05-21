import type { UploadAsset, UploadFieldConfig } from "../types/printdock";
import { lookupSavedVariantDimensions } from "../utils/field-target-product-variants";
import {
  VARIANT_MAX_DIMENSIONS_RULE_CODE,
  checkVariantMaxDimensions,
  type VariantMaxDimensionsOutcome,
} from "../utils/variant-max-dimensions";
import { log } from "../lib/logger.server";
import type { FileMetadata, ValidationResult } from "./validation.server";
import { hasBlockingError } from "./validation.server";

function buildValidationResultFromOutcome(
  outcome: Extract<VariantMaxDimensionsOutcome, { status: "fail" }>,
): ValidationResult {
  return {
    ruleId: VARIANT_MAX_DIMENSIONS_RULE_CODE,
    ruleCode: VARIANT_MAX_DIMENSIONS_RULE_CODE,
    severity: "blocking",
    message: outcome.message,
    actual: null,
    expected: 0,
    details: outcome.details,
  };
}

export function evaluateVariantMaxDimensionsForAsset(
  metadata: Pick<FileMetadata, "widthInch" | "heightInch">,
  field: UploadFieldConfig | null,
  productId: string,
  variantId: string,
  options?: { logSkips?: boolean },
): ValidationResult | null {
  const limits = field ? lookupSavedVariantDimensions(field, productId, variantId) : null;

  const outcome = checkVariantMaxDimensions({
    fileWidthInch: metadata.widthInch,
    fileHeightInch: metadata.heightInch,
    maxWidthInch: limits?.maxWidthInch,
    maxHeightInch: limits?.maxHeightInch,
  });

  if (outcome.status === "pass") {
    return null;
  }

  if (outcome.status === "skip") {
    if (options?.logSkips !== false) {
      log.event("variant_max_dimensions_skipped", {
        reason: outcome.reason,
        productId,
        variantId,
      });
    }
    return null;
  }

  return buildValidationResultFromOutcome(outcome);
}

export function isVariantMaxDimensionsResult(result: {
  ruleId?: string;
  ruleCode?: string;
}): boolean {
  return (
    result.ruleId === VARIANT_MAX_DIMENSIONS_RULE_CODE ||
    result.ruleCode === VARIANT_MAX_DIMENSIONS_RULE_CODE
  );
}

export function stripVariantMaxDimensionsResults<T extends { ruleId?: string; ruleCode?: string }>(
  results: readonly T[],
): T[] {
  return results.filter((result) => !isVariantMaxDimensionsResult(result));
}

export function revalidateAssetVariantMaxDimensions(
  asset: UploadAsset,
  field: UploadFieldConfig | null,
  productId: string,
  variantId: string,
  options?: { logSkips?: boolean },
): { asset: UploadAsset; outcome: VariantMaxDimensionsOutcome } {
  const limits = field ? lookupSavedVariantDimensions(field, productId, variantId) : null;
  const outcome = checkVariantMaxDimensions({
    fileWidthInch: asset.widthInch,
    fileHeightInch: asset.heightInch,
    maxWidthInch: limits?.maxWidthInch,
    maxHeightInch: limits?.maxHeightInch,
  });

  const validationResults = stripVariantMaxDimensionsResults(asset.validationResults);
  if (outcome.status === "fail") {
    validationResults.push(buildValidationResultFromOutcome(outcome));
  } else if (outcome.status === "skip" && options?.logSkips !== false) {
    log.event("variant_max_dimensions_skipped", {
      reason: outcome.reason,
      productId,
      variantId,
      assetId: asset.id,
    });
  }

  return {
    outcome,
    asset: {
      ...asset,
      validationResults,
      blocked: hasBlockingError(validationResults),
    },
  };
}

export function revalidateSessionAssetsForVariant(
  assets: readonly UploadAsset[],
  field: UploadFieldConfig | null,
  productId: string,
  variantId: string,
): { assets: UploadAsset[]; passCount: number; skipCount: number; failCount: number } {
  let passCount = 0;
  let skipCount = 0;
  let failCount = 0;

  const nextAssets = assets.map((asset) => {
    const { asset: updatedAsset, outcome } = revalidateAssetVariantMaxDimensions(
      asset,
      field,
      productId,
      variantId,
    );
    if (outcome.status === "pass") passCount += 1;
    else if (outcome.status === "skip") skipCount += 1;
    else failCount += 1;
    return updatedAsset;
  });

  return { assets: nextAssets, passCount, skipCount, failCount };
}
