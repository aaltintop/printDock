import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { getPresignedUploadUrl } from "../services/storage.server";
import { authenticate } from "../shopify.server";
import crypto from "crypto";
import {
  createCollectionIdResolver,
  createUploadSession,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
  getUploadField,
  getUploadSession,
  updateUploadSession,
} from "../services/shop-data.server";
import type { UploadSession } from "../types/printdock";

const schema = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  fieldId: z.string().optional(),
  sessionToken: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string(),
});

const planRank: Record<string, number> = {
  free: 0,
  basic_plus: 1,
  pro_plus: 2,
};

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  const shopDomain = session.shop;
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return data({ error: "Invalid input" }, { status: 400 });

  const { productId, variantId, fieldId, fileName, mimeType, sessionToken: existingSessionToken } = parsed.data;
  const normalizedVariantId = variantId ?? "";
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

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
    (await getActiveFieldForProduct(shopDomain, productId, normalizedVariantId, createCollectionIdResolver()));

  const billingPlan = await getEffectiveBillingPlan(shopDomain);
  if (
    billingPlan.monthlyUploadsLimit > 0 &&
    billingPlan.usageThisMonth >= billingPlan.monthlyUploadsLimit
  ) {
    return data(
      { error: "Monthly upload limit reached for your active plan" },
      { status: 402 },
    );
  }

  if (selectedField) {
    const requiredRank = planRank[selectedField.planRequirement] ?? 0;
    const currentRank = planRank[billingPlan.planCode] ?? 0;
    if (currentRank < requiredRank) {
      return data(
        { error: `This upload field requires the ${selectedField.planRequirement} plan` },
        { status: 402 },
      );
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

  // Generate presigned URL for direct browser → Storage upload
  const { presignedUrl, storagePath } = await getPresignedUploadUrl(
    shopDomain,
    sessionToken,
    fileName,
    mimeType
  );

  return data({
    sessionToken,
    expiresAt: expiresAtIso,
    presignedUrl,
    storagePath,
    maxFiles: selectedField?.maxFiles ?? 1,
  });
}
