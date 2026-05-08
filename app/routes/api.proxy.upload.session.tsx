import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { getPresignedUploadUrl } from "../services/storage.server";
import { authenticate } from "../shopify.server";
import crypto from "crypto";
import {
  getPlan,
  isWithinTotalStorage,
  storageOverageUpgradeReason,
  suggestUpgradeFor,
} from "../config/plans";
import {
  createCollectionIdResolver,
  createUploadSession,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
  getShopStorageUsageBytes,
  getUploadField,
  getUploadSession,
  updateUploadSession,
} from "../services/shop-data.server";
import type { UploadSession } from "../types/printdock";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

const schema = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  fieldId: z.string().optional(),
  sessionToken: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(1),
});

const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  business: 3,
};

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      return await handleUploadSessionAction(request);
    } catch (err) {
      log.error("upload_session_failed", err, {});
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      return data(
        {
          error: "Upload session failed",
          detail: message,
        },
        { status: 500 },
      );
    }
  });
}

async function handleUploadSessionAction(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  const shopDomain = session.shop;
  setLogShopDomain(shopDomain);

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return data({ error: "Invalid input" }, { status: 400 });

  const {
    productId,
    variantId,
    fieldId,
    fileName,
    mimeType,
    sizeBytes: incomingBytes,
    sessionToken: existingSessionToken,
  } = parsed.data;
  const normalizedVariantId = variantId ?? "";
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  log.event("upload_session_requested", {
    productId,
    variantId: normalizedVariantId,
    fieldId: fieldId ?? "",
    fileName,
    mimeType,
    hasExistingToken: Boolean(existingSessionToken),
  });

  const existingSession = existingSessionToken
    ? await getUploadSession(shopDomain, existingSessionToken)
    : null;

  if (existingSession && existingSession.productId !== productId) {
    return data({ error: "Session product mismatch" }, { status: 400 });
  }

  const sessionToken = existingSession?.id ?? crypto.randomUUID();
  const selectedField =
    (existingSession?.fieldId ? await getUploadField(shopDomain, existingSession.fieldId) : null) ??
    (fieldId ? await getUploadField(shopDomain, fieldId) : null) ??
    (await getActiveFieldForProduct(
      shopDomain,
      productId,
      normalizedVariantId,
      createCollectionIdResolver(),
    ));

  const billingPlan = await getEffectiveBillingPlan(shopDomain);
  const planCode = billingPlan.planCode;
  const planLimits = getPlan(planCode);

  const currentStorageBytes = await getShopStorageUsageBytes(shopDomain);
  if (!isWithinTotalStorage(planCode, currentStorageBytes, incomingBytes)) {
    const reason = storageOverageUpgradeReason(planCode);
    log.event("upload_blocked_total_storage", {
      shopDomain,
      planCode,
      currentBytes: currentStorageBytes,
      maxBytes: planLimits.maxTotalStorageBytes,
      requestedBytes: incomingBytes,
      fieldId: fieldId ?? "",
    });
    return data(
      {
        error: "storage_cap_exceeded",
        message: "Storage limit reached for this shop.",
        currentBytes: currentStorageBytes,
        maxBytes: planLimits.maxTotalStorageBytes,
        suggestedPlan: suggestUpgradeFor(reason),
      },
      { status: 402 },
    );
  }

  if (selectedField) {
    const requiredRank = PLAN_RANK[selectedField.planRequirement] ?? 0;
    const currentRank = PLAN_RANK[planCode] ?? 0;
    if (currentRank < requiredRank) {
      return data(
        { error: `This field requires the ${selectedField.planRequirement} plan` },
        { status: 402 },
      );
    }

    if (selectedField.maxFileMB) {
      const fieldMaxBytes = selectedField.maxFileMB * 1024 * 1024;
      const effectiveMax = Math.min(fieldMaxBytes, planLimits.maxFileSizeBytes);
      selectedField.maxFileMB = Math.floor(effectiveMax / (1024 * 1024));
    }
  }

  if (!existingSession) {
    const sessionDoc: UploadSession = {
      id: sessionToken,
      shopDomain,
      productId,
      variantId: normalizedVariantId,
      fieldId: selectedField?.id ?? null,
      status: "active",
      expiresAt: expiresAtIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      asset: null,
      assets: [],
    };
    await createUploadSession(shopDomain, sessionDoc);
  } else {
    if (selectedField && existingSession.assets.length >= selectedField.maxFiles) {
      return data(
        { error: `Maximum file count reached (${selectedField.maxFiles})` },
        { status: 400 },
      );
    }

    await updateUploadSession(shopDomain, sessionToken, {
      expiresAt: expiresAtIso,
      status: "active",
    });
  }

  const { presignedUrl, storagePath } = await getPresignedUploadUrl(
    shopDomain,
    sessionToken,
    fileName,
    mimeType,
  );

  return data({
    sessionToken,
    expiresAt: expiresAtIso,
    presignedUrl,
    storagePath,
    maxFiles: selectedField?.maxFiles ?? 1,
  });
}
