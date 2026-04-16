import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { createPrintReadyFileToken } from "../services/file-download-token.server";
import { getFileBuffer } from "../services/storage.server";
import { extractMetadata, runValidationRules, hasBlockingError } from "../services/validation.server";
import { calculatePrice } from "../services/pricing.server";
import { authenticate } from "../shopify.server";
import {
  createCollectionIdResolver,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
  getUploadField,
  getUploadSession,
  incrementBillingUsage,
  updateUploadSession,
} from "../services/shop-data.server";
import type { UploadAsset } from "../types/printdock";
import type { ValidationRule } from "../services/validation.server";

const schema = z.object({
  sessionToken: z.string(),
  storagePath: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  quantity: z.number().int().min(1).optional().default(1),
});

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  const shopDomain = session.shop;
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return data({ error: "Invalid input" }, { status: 400 });

  const { sessionToken, storagePath, originalName, mimeType, sizeBytes, quantity } = parsed.data;

  // Verify S3 object key isolation to prevent arbitrary file access
  if (!storagePath.startsWith(`uploads/${shopDomain}/${sessionToken}/`)) {
    return data({ error: "Invalid storage path" }, { status: 403 });
  }

  // Find session
  const sessionData = await getUploadSession(shopDomain, sessionToken);
  if (!sessionData) return data({ error: "Session not found" }, { status: 404 });
  const billingPlan = await getEffectiveBillingPlan(shopDomain);
  
  if (sessionData.status === "expired" || new Date(sessionData.expiresAt).getTime() < Date.now()) {
    return data({ error: "Session expired" }, { status: 410 });
  }

  // Get file from Storage for server-side validation only
  const buffer = await getFileBuffer(storagePath);

  // Extract metadata with sharp / pdf-lib
  const { metadata, actualMimeType, error } = await extractMetadata(buffer, mimeType, sizeBytes);

  if (error) {
    return data({ error }, { status: 400 });
  }

  const field =
    (sessionData.fieldId ? await getUploadField(shopDomain, sessionData.fieldId) : null) ??
    (await getActiveFieldForProduct(shopDomain, sessionData.productId, sessionData.variantId, createCollectionIdResolver()));
  const allowedMaxFileMB = Math.min(field?.maxFileMB ?? Infinity, billingPlan.maxFileMBLimit || Infinity);
  if (Number.isFinite(allowedMaxFileMB) && sizeBytes > allowedMaxFileMB * 1024 * 1024) {
    return data(
      { error: `File exceeds plan limit of ${allowedMaxFileMB}MB` },
      { status: 402 },
    );
  }

  if (field && sessionData.assets.length >= field.maxFiles) {
    return data(
      { error: `Maximum file count reached (${field.maxFiles})` },
      { status: 400 },
    );
  }

  // Run validation rules
  const rules: ValidationRule[] = (field?.dimensionRules ?? [])
    .filter(() => billingPlan.allowAdvancedRules)
    .map((rule) => ({
    id: rule.id,
    type: rule.dimensionType,
    operator: rule.operator,
    value: rule.value,
    action: rule.action === "prevent" ? "blocking" : "warning",
    message: rule.warningMessage,
  }));

  const validationResults = runValidationRules(metadata, rules);
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

  if (field?.pricing?.enabled && field.pricing.dpi > 0 && metadata.dpi && metadata.dpi < field.pricing.dpi) {
    validationResults.push({
      ruleId: "dpi_target",
      severity: "warning",
      message: `DPI is below recommended minimum (${field.pricing.dpi})`,
      actual: metadata.dpi,
      expected: field.pricing.dpi,
    });
  }

  const blocked = hasBlockingError(validationResults);

  // Calculate price
  let pricing = null;
  if (field?.pricing?.enabled && !billingPlan.allowAutoPricing) {
    validationResults.push({
      ruleId: "plan_auto_pricing",
      severity: "warning",
      message: "Auto pricing is not available on your current plan",
      actual: null,
      expected: 0,
    });
  }

  if (field?.pricing?.enabled && billingPlan.allowAutoPricing && !blocked) {
    pricing = calculatePrice(
      metadata,
      {
        mode: field.pricing.unitType,
        unitPrice: field.pricing.unitPrice ?? 0,
        minPrice: field.pricing.minPrice ?? 0,
        roundingEnabled: field.pricing.roundingEnabled,
        printWidth: field.pricing.printWidth,
      },
      quantity,
    );
  }

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
    blocked,
  };

  const previousAssets = sessionData.assets.filter(
    (existingAsset) => existingAsset.storagePath !== asset.storagePath,
  );
  const updatedAssets = [...previousAssets, asset];
  const sessionBlocked = updatedAssets.some((entry) => entry.blocked);

  await updateUploadSession(shopDomain, sessionToken, {
    asset: updatedAssets[updatedAssets.length - 1] ?? asset,
    assets: updatedAssets,
    status: sessionBlocked ? "blocked" : "success",
  });
  const usage = await incrementBillingUsage(shopDomain, 1);

  const downloadSecret = process.env.SHOPIFY_API_SECRET || "";
  const printReadyToken = createPrintReadyFileToken(
    shopDomain,
    storagePath,
    originalName,
    downloadSecret,
  );
  const printReadyFileUrl =
    !blocked && printReadyToken
      ? `https://${shopDomain}/apps/printdock/api/proxy/upload/file?token=${encodeURIComponent(printReadyToken)}`
      : null;

  return data({
    asset,
    metadata,
    validationResults,
    blocked,
    pricing,
    assetsCount: updatedAssets.length,
    sessionBlocked,
    printReadyFileUrl,
    usage: {
      current: usage.usageThisMonth,
      limit: usage.monthlyUploadsLimit,
    },
  });
}
