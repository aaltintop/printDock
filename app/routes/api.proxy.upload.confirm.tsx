import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { db } from "../firebase.server";
import { getFileBuffer, deleteFile } from "../services/storage.server";
import { extractMetadata, runValidationRules, hasBlockingError } from "../services/validation.server";
import { calculatePrice } from "../services/pricing.server";
import { authenticate } from "../shopify.server";

const schema = z.object({
  sessionToken: z.string(),
  storagePath: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
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

  const { sessionToken, storagePath, originalName, mimeType, sizeBytes } = parsed.data;

  // Verify S3 object key isolation to prevent arbitrary file access
  if (!storagePath.startsWith(`uploads/${shopDomain}/${sessionToken}/`)) {
    return data({ error: "Invalid storage path" }, { status: 403 });
  }

  // Find session
  const sessionDoc = await db.collection("sessions").doc(sessionToken).get();
  if (!sessionDoc.exists) return data({ error: "Session not found" }, { status: 404 });
  const sessionData = sessionDoc.data();
  if (!sessionData) return data({ error: "Session empty" }, { status: 404 });
  
  if (sessionData.status === "expired" || new Date(sessionData.expiresAt) < new Date()) {
    return data({ error: "Session expired" }, { status: 410 });
  }

  // Single file constraint: if asset already exists, delete the old one
  if (sessionData.asset && sessionData.asset.storagePath) {
    await deleteFile(sessionData.asset.storagePath);
  }

  // Get file from Storage for server-side validation only
  const buffer = await getFileBuffer(storagePath);

  // Extract metadata with sharp / pdf-lib
  const { metadata, actualMimeType, error } = await extractMetadata(buffer, mimeType, sizeBytes);

  if (error) {
    return data({ error }, { status: 400 });
  }

  // Find upload field config for this product
  const fieldsSnapshot = await db.collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .where("productId", "==", sessionData.productId)
    .limit(1)
    .get();

  const field = fieldsSnapshot.empty ? null : fieldsSnapshot.docs[0].data();

  // Run validation rules
  const rules = field?.validationRules || [];
  const validationResults = runValidationRules(metadata, rules);
  const blocked = hasBlockingError(validationResults);

  // Calculate price
  let pricing = null;
  if (field?.pricingMode && !blocked) {
    pricing = calculatePrice(
      metadata,
      {
        mode: field.pricingMode as any,
        unitPrice: field.unitPrice ?? 0,
        minPrice: field.minPrice ?? 0,
      }
    );
  }

  const asset = {
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

  // Update session with embedded asset
  await db.collection("sessions").doc(sessionToken).update({
    asset,
    status: blocked ? "blocked" : "success",
  });

  return data({
    metadata,
    validationResults,
    blocked,
    pricing,
  });
}
