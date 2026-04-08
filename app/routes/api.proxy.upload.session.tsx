import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { db } from "../firebase.server";
import { getPresignedUploadUrl } from "../services/storage.server";
import { authenticate } from "../shopify.server";
import crypto from "crypto";

const schema = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string(),
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

  const { productId, variantId, fileName, mimeType } = parsed.data;

  // Single file constraint: generate a new session token for the upload
  const sessionToken = crypto.randomUUID();

  // Create session in Firestore
  await db.collection("sessions").doc(sessionToken).set({
    shopDomain,
    productId,
    variantId,
    status: "active",
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
    asset: null, // Will be populated on confirm
  });

  // Generate presigned URL for direct browser → Storage upload
  const { presignedUrl, storagePath } = await getPresignedUploadUrl(
    shopDomain,
    sessionToken,
    fileName,
    mimeType
  );

  return data({
    sessionToken,
    presignedUrl,
    storagePath,
  });
}
