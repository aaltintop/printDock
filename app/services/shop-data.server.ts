import { DEFAULT_FILE_RENAME_PATTERN } from "../utils/file-rename-pattern";
import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import { unauthenticated } from "../shopify.server";
import type { PlanCode } from "../config/plans";
import { migratePlanCode, planCodeFromSubscriptionName } from "../config/plans";
import type {
  AppSettings,
  BillingPlan,
  DashboardStats,
  OrderJob,
  OrderJobAuditEvent,
  UploadAsset,
  UploadFieldConfig,
  UploadSession,
} from "../types/printdock";

const DEFAULT_ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "pdf"];

/** After this duration from `deletedAt`, hard-delete helpers may remove the document from Firestore. */
export const UPLOAD_FIELD_SOFT_DELETE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function isFieldVisibleToMerchant(field: UploadFieldConfig): boolean {
  return !field.deletedAt?.trim();
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: "en",
  stylePreset: "minimal",
  requireThemeBlock: true,
  uploadRetentionDays: 30,
  defaultOrderStatus: "uploaded",
  csvDelimiter: ",",
  autoAssignEnabled: false,
  autoAssignEmailDomain: "",
  updatedAt: new Date(0).toISOString(),
};

export const DEFAULT_BILLING_PLAN: BillingPlan = {
  planCode: "free",
  status: "trial",
  subscriptionId: null,
  usageThisMonth: 0,
  usageMonthKey: "1970-01",
  updatedAt: new Date(0).toISOString(),
};

export function currentUsageMonthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function toIsoDate(value: unknown, fallback = new Date().toISOString()): string {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const dateValue = (value as { toDate: () => Date }).toDate();
    return dateValue.toISOString();
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAsset(id: string, raw: unknown): UploadAsset {
  const asset = isRecord(raw) ? raw : {};
  return {
    id,
    storagePath: String(asset.storagePath ?? ""),
    originalName: String(asset.originalName ?? ""),
    mimeType: String(asset.mimeType ?? "application/octet-stream"),
    fileExtension: String(asset.fileExtension ?? ""),
    sizeBytes: Number(asset.sizeBytes ?? 0),
    widthPx: Number(asset.widthPx ?? 0) || null,
    heightPx: Number(asset.heightPx ?? 0) || null,
    dpi: Number(asset.dpi ?? 0) || null,
    widthInch: Number(asset.widthInch ?? 0) || null,
    heightInch: Number(asset.heightInch ?? 0) || null,
    pageCount: Number(asset.pageCount ?? 0) || null,
    validationResults: Array.isArray(asset.validationResults)
      ? (asset.validationResults as UploadAsset["validationResults"])
      : [],
    pricing: isRecord(asset.pricing)
      ? {
          filePrice: Number(asset.pricing.filePrice ?? 0),
          total: Number(asset.pricing.total ?? 0),
          explanation: String(asset.pricing.explanation ?? ""),
          currency: String(asset.pricing.currency ?? "USD"),
        }
      : null,
    blocked: Boolean(asset.blocked),
    ...(asset.storageExpired === true ? { storageExpired: true as const } : {}),
  };
}

function normalizeField(docId: string, raw: unknown): UploadFieldConfig {
  const field = isRecord(raw) ? raw : {};

  const legacyProductId = String(field.productId ?? "");
  const legacyProductHandle = String(field.productHandle ?? "");

  const targetProducts: UploadFieldConfig["targetProducts"] = Array.isArray(field.targetProducts)
    ? field.targetProducts
        .filter((p): p is Record<string, unknown> => isRecord(p))
        .map((p) => ({
          id: String(p.id ?? ""),
          title: String(p.title ?? ""),
          handle: String(p.handle ?? ""),
        }))
    : [];
  const targetCollections: UploadFieldConfig["targetCollections"] = Array.isArray(field.targetCollections)
    ? field.targetCollections
        .filter((c): c is Record<string, unknown> => isRecord(c))
        .map((c) => ({
          id: String(c.id ?? ""),
          title: String(c.title ?? ""),
        }))
    : [];

  if (targetProducts.length === 0 && legacyProductId) {
    targetProducts.push({ id: legacyProductId, title: "", handle: legacyProductHandle });
  }

  const targetProductIds: string[] = Array.isArray(field.targetProductIds)
    ? field.targetProductIds.map((v) => String(v))
    : targetProducts.map((p) => p.id).filter(Boolean);
  const targetCollectionIds: string[] = Array.isArray(field.targetCollectionIds)
    ? field.targetCollectionIds.map((v) => String(v))
    : targetCollections.map((c) => c.id).filter(Boolean);

  const deletedAtRaw = field.deletedAt;
  const deletedAt =
    typeof deletedAtRaw === "string" && deletedAtRaw.trim() !== ""
      ? deletedAtRaw.trim()
      : undefined;

  return {
    id: docId,
    productId: legacyProductId,
    productHandle: legacyProductHandle,
    targetVariantIds: Array.isArray(field.targetVariantIds)
      ? field.targetVariantIds.map((value) => String(value))
      : [],
    targetProducts,
    targetCollections,
    targetProductIds,
    targetCollectionIds,
    isActive: field.isActive !== false,
    isRequired: Boolean(field.isRequired),
    adminTitle: String(field.adminTitle ?? "Field"),
    storefrontTitle: String(field.storefrontTitle ?? "Upload your artwork"),
    storefrontDescription: String(
      field.storefrontDescription ?? "Upload your design file before checkout.",
    ),
    fileRenamingPattern: String(field.fileRenamingPattern ?? DEFAULT_FILE_RENAME_PATTERN),
    minFiles: Math.max(1, Number(field.minFiles ?? 1)),
    maxFiles: Math.max(1, Number(field.maxFiles ?? 1)),
    allowedExtensions: Array.isArray(field.allowedExtensions)
      ? field.allowedExtensions.map((value) => String(value).toLowerCase())
      : DEFAULT_ALLOWED_EXTENSIONS,
    maxFileMB: Math.max(1, Number(field.maxFileMB ?? 50)),
    fileQuantityManagement: {
      enabled: Boolean(isRecord(field.fileQuantityManagement) && field.fileQuantityManagement.enabled),
      mode:
        isRecord(field.fileQuantityManagement) &&
        (field.fileQuantityManagement.mode === "per_file" ||
          field.fileQuantityManagement.mode === "product_quantity")
          ? (field.fileQuantityManagement.mode as "per_file" | "product_quantity")
          : "product_quantity",
    },
    pricing: {
      enabled: Boolean(isRecord(field.pricing) && field.pricing.enabled),
      unitType:
        isRecord(field.pricing) &&
        ["inch_height", "inch_square", "per_file", "flat"].includes(String(field.pricing.unitType))
          ? (field.pricing.unitType as "inch_height" | "inch_square" | "per_file" | "flat")
          : "flat",
      unitPrice: Number(isRecord(field.pricing) ? field.pricing.unitPrice ?? 0 : 0),
      minPrice: Number(isRecord(field.pricing) ? field.pricing.minPrice ?? 0 : 0),
      dpi: Number(isRecord(field.pricing) ? field.pricing.dpi ?? 300 : 300),
      printWidth: Number(isRecord(field.pricing) ? field.pricing.printWidth ?? 22 : 22),
      roundingEnabled: Boolean(isRecord(field.pricing) && field.pricing.roundingEnabled),
    },
    dimensionRules: Array.isArray(field.dimensionRules)
      ? (field.dimensionRules as UploadFieldConfig["dimensionRules"])
      : [],
    planRequirement: migratePlanCode(String(field.planRequirement ?? "free")),
    createdAt: toIsoDate(field.createdAt),
    updatedAt: toIsoDate(field.updatedAt),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

function normalizeSession(docId: string, shopDomain: string, raw: unknown): UploadSession {
  const session = isRecord(raw) ? raw : {};
  const assets = Array.isArray(session.assets)
    ? session.assets
        .filter((value): value is Record<string, unknown> => isRecord(value))
        .map((value, index) => normalizeAsset(String(value.id ?? `asset_${index}`), value))
    : [];
  const legacyAsset = session.asset ? normalizeAsset("asset_legacy", session.asset) : null;
  const mergedAssets = assets.length > 0 ? assets : legacyAsset ? [legacyAsset] : [];

  return {
    id: docId,
    shopDomain,
    productId: String(session.productId ?? ""),
    variantId: String(session.variantId ?? ""),
    fieldId: session.fieldId ? String(session.fieldId) : null,
    status:
      session.status === "success" ||
      session.status === "blocked" ||
      session.status === "converted" ||
      session.status === "expired"
        ? session.status
        : "active",
    expiresAt: toIsoDate(session.expiresAt),
    createdAt: toIsoDate(session.createdAt),
    updatedAt: toIsoDate(session.updatedAt),
    asset: mergedAssets[0] ?? null,
    assets: mergedAssets,
  };
}

function normalizeJob(docId: string, shopDomain: string, raw: unknown): OrderJob {
  const job = isRecord(raw) ? raw : {};
  return {
    id: docId,
    shopDomain,
    shopifyOrderId: String(job.shopifyOrderId ?? ""),
    shopifyOrderName: String(job.shopifyOrderName ?? ""),
    shopifyLineItemId: String(job.shopifyLineItemId ?? ""),
    sessionId: String(job.sessionId ?? ""),
    shippingAddress: isRecord(job.shippingAddress) ? job.shippingAddress : null,
    productId: String(job.productId ?? ""),
    variantId: String(job.variantId ?? ""),
    assetSnapshot: job.assetSnapshot ? normalizeAsset("asset_snapshot", job.assetSnapshot) : null,
    legacySessionUploadPath:
      typeof job.legacySessionUploadPath === "string" ? job.legacySessionUploadPath : undefined,
    lineItemPropsSnapshot: Array.isArray(job.lineItemPropsSnapshot)
      ? (job.lineItemPropsSnapshot as Array<{ name: string; value: string }>)
      : [],
    calculatedPrice: Number(job.calculatedPrice ?? 0),
    warnings: Array.isArray(job.warnings) ? job.warnings.map((value) => String(value)) : [],
    status: String(job.status ?? "uploaded"),
    assignee: job.assignee ? String(job.assignee) : null,
    internalNotes: String(job.internalNotes ?? ""),
    tags: Array.isArray(job.tags) ? job.tags.map((value) => String(value)) : [],
    createdAt: toIsoDate(job.createdAt),
    updatedAt: toIsoDate(job.updatedAt),
  };
}

export function shopDoc(shopDomain: string) {
  return db.collection("shops").doc(shopDomain);
}

export function fieldsCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection("fields");
}

export function sessionsCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection("sessions");
}

export function sessionAssetsCollection(shopDomain: string, sessionToken: string) {
  return sessionsCollection(shopDomain).doc(sessionToken).collection("assets");
}

export function jobsCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection("jobs");
}

export function billableLinesCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection("billableLines");
}

export function jobAuditCollection(shopDomain: string, jobId: string) {
  return jobsCollection(shopDomain).doc(jobId).collection("audit");
}

export function reuploadRequestsCollection(shopDomain: string, jobId: string) {
  return jobsCollection(shopDomain).doc(jobId).collection("reuploadRequests");
}

export async function listUploadFields(shopDomain: string): Promise<UploadFieldConfig[]> {
  const nestedSnapshot = await fieldsCollection(shopDomain).get();
  if (!nestedSnapshot.empty) {
    return nestedSnapshot.docs
      .map((doc) => normalizeField(doc.id, doc.data()))
      .filter(isFieldVisibleToMerchant);
  }

  const legacySnapshot = await db
    .collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .get();
  return legacySnapshot.docs
    .map((doc) => normalizeField(doc.id, doc.data()))
    .filter(isFieldVisibleToMerchant);
}

export async function getUploadField(shopDomain: string, fieldId: string): Promise<UploadFieldConfig | null> {
  const nestedDoc = await fieldsCollection(shopDomain).doc(fieldId).get();
  if (nestedDoc.exists) {
    const normalized = normalizeField(nestedDoc.id, nestedDoc.data());
    return isFieldVisibleToMerchant(normalized) ? normalized : null;
  }

  const legacyDoc = await db.collection("uploadFields").doc(fieldId).get();
  if (!legacyDoc.exists) return null;
  const legacyData = legacyDoc.data();
  if (!legacyData || legacyData.shopDomain !== shopDomain) return null;
  const normalized = normalizeField(fieldId, legacyData);
  return isFieldVisibleToMerchant(normalized) ? normalized : null;
}

const COLLECTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function productCollectionCacheRef(shopDomain: string, productId: string) {
  return db.collection("shops").doc(shopDomain).collection("productCollectionCache").doc(productId);
}

export async function getCachedCollectionIds(
  shopDomain: string,
  productId: string,
): Promise<string[] | null> {
  const doc = await productCollectionCacheRef(shopDomain, productId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!data || !Array.isArray(data.collectionIds)) return null;
  const cachedAt = new Date(data.cachedAt).getTime();
  if (Date.now() - cachedAt > COLLECTION_CACHE_TTL_MS) return null;
  return data.collectionIds.map((id: unknown) => String(id));
}

export async function setCachedCollectionIds(
  shopDomain: string,
  productId: string,
  collectionIds: string[],
): Promise<void> {
  await productCollectionCacheRef(shopDomain, productId).set({
    collectionIds,
    cachedAt: new Date().toISOString(),
  });
}

function extractNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export function createCollectionIdResolver(): CollectionIdResolver {
  return async (shopDomain: string, productId: string): Promise<string[]> => {
    try {
      const { admin } = await unauthenticated.admin(shopDomain);
      const productGid = `gid://shopify/Product/${productId}`;
      const response = await admin.graphql(
        `#graphql
        query ProductCollections($id: ID!) {
          product(id: $id) {
            collections(first: 50) {
              edges { node { id } }
            }
          }
        }`,
        { variables: { id: productGid } },
      );
      const json = await response.json();
      const edges = json?.data?.product?.collections?.edges ?? [];
      return edges.map((edge: any) => extractNumericId(String(edge.node.id)));
    } catch (err) {
      log.warn("collection_id_resolve_failed", err instanceof Error ? err.message : String(err), {
        shopDomain,
        productId,
      });
      return [];
    }
  };
}

function pickVariantMatch(
  fields: UploadFieldConfig[],
  variantId: string,
): UploadFieldConfig | null {
  const matched = fields.find(
    (f) => f.targetVariantIds.length === 0 || f.targetVariantIds.includes(variantId),
  );
  return matched ?? fields[0] ?? null;
}

export type CollectionIdResolver = (
  shopDomain: string,
  productId: string,
) => Promise<string[]>;

export async function getActiveFieldForProduct(
  shopDomain: string,
  productId: string,
  variantId: string,
  resolveCollectionIds?: CollectionIdResolver,
): Promise<UploadFieldConfig | null> {
  // Step 1: Direct product match via targetProductIds
  const directSnapshot = await fieldsCollection(shopDomain)
    .where("targetProductIds", "array-contains", productId)
    .where("isActive", "==", true)
    .limit(15)
    .get();
  const directFields = directSnapshot.docs
    .map((doc) => normalizeField(doc.id, doc.data()))
    .filter(isFieldVisibleToMerchant);
  if (directFields.length > 0) {
    return pickVariantMatch(directFields, variantId);
  }

  // Step 2: Legacy productId fallback for old documents
  const legacySnapshot = await fieldsCollection(shopDomain)
    .where("productId", "==", productId)
    .where("isActive", "==", true)
    .limit(15)
    .get();
  const legacyFields = legacySnapshot.docs
    .map((doc) => normalizeField(doc.id, doc.data()))
    .filter(isFieldVisibleToMerchant);
  if (legacyFields.length > 0) {
    return pickVariantMatch(legacyFields, variantId);
  }

  // Step 3: Collection-based match (requires resolving product's collections)
  if (resolveCollectionIds) {
    let collectionIds = await getCachedCollectionIds(shopDomain, productId);
    if (!collectionIds) {
      collectionIds = await resolveCollectionIds(shopDomain, productId);
      await setCachedCollectionIds(shopDomain, productId, collectionIds);
    }

    if (collectionIds.length > 0) {
      const batchSize = 10; // Firestore array-contains-any limit
      for (let i = 0; i < collectionIds.length; i += batchSize) {
        const batch = collectionIds.slice(i, i + batchSize);
        const collectionSnapshot = await fieldsCollection(shopDomain)
          .where("targetCollectionIds", "array-contains-any", batch)
          .where("isActive", "==", true)
          .limit(15)
          .get();
        const collectionFields = collectionSnapshot.docs
          .map((doc) => normalizeField(doc.id, doc.data()))
          .filter(isFieldVisibleToMerchant);
        if (collectionFields.length > 0) {
          return pickVariantMatch(collectionFields, variantId);
        }
      }
    }
  }

  // Step 4: Top-level legacy collection fallback
  const topLevelLegacySnapshot = await db
    .collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .where("productId", "==", productId)
    .where("isActive", "==", true)
    .limit(15)
    .get();
  const topLevelLegacyFields = topLevelLegacySnapshot.docs
    .map((doc) => normalizeField(doc.id, doc.data()))
    .filter(isFieldVisibleToMerchant);
  if (topLevelLegacyFields.length > 0) {
    return pickVariantMatch(topLevelLegacyFields, variantId);
  }

  return null;
}

export async function saveUploadField(shopDomain: string, field: UploadFieldConfig): Promise<void> {
  await fieldsCollection(shopDomain).doc(field.id).set(
    {
      ...field,
      shopDomain,
      updatedAt: new Date().toISOString(),
      createdAt: field.createdAt || new Date().toISOString(),
    },
    { merge: true },
  );
}

/**
 * Merchant-facing delete: marks the field as removed (`deletedAt`, `isActive: false`) but keeps
 * the Firestore document for ~{@link UPLOAD_FIELD_SOFT_DELETE_RETENTION_MS} before optional purge.
 */
export async function softDeleteUploadField(shopDomain: string, fieldId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const nestedRef = fieldsCollection(shopDomain).doc(fieldId);
  const legacyRef = db.collection("uploadFields").doc(fieldId);

  const [nestedSnap, legacySnap] = await Promise.all([nestedRef.get(), legacyRef.get()]);

  let found = false;

  if (nestedSnap.exists) {
    await nestedRef.set(
      {
        shopDomain,
        deletedAt: nowIso,
        updatedAt: nowIso,
        isActive: false,
      },
      { merge: true },
    );
    found = true;
  }
  if (legacySnap.exists) {
    const data = legacySnap.data();
    if (data && String(data.shopDomain) === shopDomain) {
      await legacyRef.set(
        {
          deletedAt: nowIso,
          updatedAt: nowIso,
          isActive: false,
        },
        { merge: true },
      );
      found = true;
    }
  }

  return found;
}

/**
 * Hard-deletes nested shop field docs whose `deletedAt` is older than the retention window.
 * Call from a scheduled job (e.g. monthly). Legacy `uploadFields` rows may need a composite index
 * if you extend this to cover that collection.
 */
export async function purgeUploadFieldsPastSoftDeleteRetention(shopDomain: string): Promise<number> {
  const cutoffIso = new Date(Date.now() - UPLOAD_FIELD_SOFT_DELETE_RETENTION_MS).toISOString();
  let removed = 0;

  for (;;) {
    const snap = await fieldsCollection(shopDomain)
      .where("deletedAt", "<=", cutoffIso)
      .limit(400)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    removed += snap.size;
    if (snap.size < 400) break;
  }

  return removed;
}

export async function createUploadSession(shopDomain: string, session: UploadSession): Promise<void> {
  await sessionsCollection(shopDomain).doc(session.id).set(
    {
      ...session,
      shopDomain,
      updatedAt: new Date().toISOString(),
      createdAt: session.createdAt || new Date().toISOString(),
      assets: session.assets,
      asset: session.assets[0] ?? session.asset ?? null,
    },
    { merge: true },
  );

  for (const asset of session.assets) {
    await sessionAssetsCollection(shopDomain, session.id).doc(asset.id).set(asset, { merge: true });
  }
}

export async function getUploadSession(
  shopDomain: string,
  sessionToken: string,
): Promise<UploadSession | null> {
  const nestedDoc = await sessionsCollection(shopDomain).doc(sessionToken).get();
  if (nestedDoc.exists) {
    return normalizeSession(nestedDoc.id, shopDomain, nestedDoc.data());
  }

  const legacyDoc = await db.collection("sessions").doc(sessionToken).get();
  if (!legacyDoc.exists) return null;
  const legacyData = legacyDoc.data();
  if (!legacyData || legacyData.shopDomain !== shopDomain) return null;
  return normalizeSession(sessionToken, shopDomain, legacyData);
}

export async function updateUploadSession(
  shopDomain: string,
  sessionToken: string,
  patch: Partial<UploadSession> & { asset?: UploadAsset | null; assets?: UploadAsset[] },
): Promise<void> {
  const nestedRef = sessionsCollection(shopDomain).doc(sessionToken);
  const nestedDoc = await nestedRef.get();
  const payload = {
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (patch.assets && patch.assets.length > 0) {
    for (const asset of patch.assets) {
      await sessionAssetsCollection(shopDomain, sessionToken).doc(asset.id).set(asset, { merge: true });
    }
  }

  if (nestedDoc.exists) {
    await nestedRef.set(payload, { merge: true });
    return;
  }

  await db.collection("sessions").doc(sessionToken).set(payload, { merge: true });
}

export async function listUploadSessions(shopDomain: string): Promise<UploadSession[]> {
  const nestedSnapshot = await sessionsCollection(shopDomain).get();
  if (!nestedSnapshot.empty) {
    return nestedSnapshot.docs.map((doc) => normalizeSession(doc.id, shopDomain, doc.data()));
  }

  const legacySnapshot = await db.collection("sessions").where("shopDomain", "==", shopDomain).get();
  return legacySnapshot.docs.map((doc) => normalizeSession(doc.id, shopDomain, doc.data()));
}

export async function listOrderJobs(shopDomain: string): Promise<OrderJob[]> {
  const nestedSnapshot = await jobsCollection(shopDomain).get();
  if (!nestedSnapshot.empty) {
    return nestedSnapshot.docs.map((doc) => normalizeJob(doc.id, shopDomain, doc.data()));
  }

  const legacySnapshot = await db.collection("jobs").where("shopDomain", "==", shopDomain).get();
  return legacySnapshot.docs.map((doc) => normalizeJob(doc.id, shopDomain, doc.data()));
}

export async function findJobByLegacySessionUploadPath(
  shopDomain: string,
  legacyPath: string,
): Promise<OrderJob | null> {
  if (!legacyPath) return null;
  const snap = await jobsCollection(shopDomain)
    .where("legacySessionUploadPath", "==", legacyPath)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return normalizeJob(doc.id, shopDomain, doc.data());
}

export async function saveOrderJob(shopDomain: string, job: OrderJob): Promise<void> {
  await jobsCollection(shopDomain).doc(job.id).set(
    {
      ...job,
      updatedAt: new Date().toISOString(),
      createdAt: job.createdAt || new Date().toISOString(),
      shopDomain,
    },
    { merge: true },
  );
}

/** Patch order job on nested path if present, otherwise top-level legacy `jobs` collection. */
export async function mergeOrderJob(shopDomain: string, jobId: string, patch: Partial<OrderJob>): Promise<void> {
  const nowIso = new Date().toISOString();
  const nestedRef = jobsCollection(shopDomain).doc(jobId);
  const nestedDoc = await nestedRef.get();
  if (nestedDoc.exists) {
    await nestedRef.set(
      {
        ...patch,
        updatedAt: nowIso,
        shopDomain,
      },
      { merge: true },
    );
    return;
  }
  const legacyRef = db.collection("jobs").doc(jobId);
  const legacyDoc = await legacyRef.get();
  if (!legacyDoc.exists) return;
  await legacyRef.set(
    {
      ...patch,
      updatedAt: nowIso,
      shopDomain,
    },
    { merge: true },
  );
}

export async function appendOrderJobAuditEvent(
  shopDomain: string,
  jobId: string,
  event: Omit<OrderJobAuditEvent, "id" | "createdAt">,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await jobAuditCollection(shopDomain, jobId).add({
    ...event,
    createdAt,
  });
}

export async function listOrderJobAuditEvents(
  shopDomain: string,
  jobId: string,
  limit = 20,
): Promise<OrderJobAuditEvent[]> {
  const snapshot = await jobAuditCollection(shopDomain, jobId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => {
    const raw = doc.data();
    return {
      id: doc.id,
      eventType: String(raw.eventType ?? ""),
      message: String(raw.message ?? ""),
      metadata: isRecord(raw.metadata) ? raw.metadata : {},
      actor: String(raw.actor ?? "system"),
      createdAt: toIsoDate(raw.createdAt),
    };
  });
}

export async function createReuploadRequest(shopDomain: string, jobId: string): Promise<string> {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const nowIso = new Date().toISOString();
  await reuploadRequestsCollection(shopDomain, jobId).doc(token).set({
    token,
    status: "pending",
    createdAt: nowIso,
  });
  return token;
}

export async function getShopPlan(shopDomain: string): Promise<PlanCode> {
  const billing = await getEffectiveBillingPlan(shopDomain);
  return billing.planCode;
}

export async function updateShopPlan(
  shopDomain: string,
  planCode: PlanCode,
): Promise<void> {
  await saveBillingPlan(shopDomain, { planCode });
}

export async function getBillingPlan(shopDomain: string): Promise<BillingPlan> {
  const nestedDoc = await shopDoc(shopDomain).collection("billing").doc("plan").get();
  if (nestedDoc.exists) {
    const raw = nestedDoc.data() as Record<string, unknown>;
    return {
      ...DEFAULT_BILLING_PLAN,
      ...raw,
      planCode: migratePlanCode(String(raw?.planCode ?? "free")),
    };
  }

  const legacyDoc = await db.collection("billingPlans").doc(shopDomain).get();
  if (!legacyDoc.exists) return DEFAULT_BILLING_PLAN;
  const raw = legacyDoc.data() as Record<string, unknown>;
  return {
    ...DEFAULT_BILLING_PLAN,
    ...raw,
    planCode: migratePlanCode(String(raw?.planCode ?? "free")),
  };
}

export async function getEffectiveBillingPlan(shopDomain: string): Promise<BillingPlan> {
  const billingPlan = await getBillingPlan(shopDomain);
  const monthKey = currentUsageMonthKey();
  if (billingPlan.usageMonthKey === monthKey) {
    return billingPlan;
  }

  const resetPlan = {
    ...billingPlan,
    usageMonthKey: monthKey,
    usageThisMonth: 0,
  };
  await saveBillingPlan(shopDomain, resetPlan);
  return {
    ...DEFAULT_BILLING_PLAN,
    ...resetPlan,
  };
}

function normalizeShopifySubscriptionStatus(status: unknown): string {
  return String(status ?? "")
    .trim()
    .toUpperCase();
}

/**
 * Align Firestore `shops/{shop}/billing/plan` with Shopify Admin `currentAppInstallation.activeSubscriptions`.
 * Webhooks remain primary; this catches missed/late updates when the merchant opens the embedded app.
 */
export async function reconcileBillingPlanFromShopifySubscriptions(
  shopDomain: string,
  subscriptions: Array<{ id?: string; name?: string; status?: string }> | null | undefined,
): Promise<void> {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const activeSub = subs.find((s) => {
    const st = normalizeShopifySubscriptionStatus(s?.status);
    return st === "ACTIVE" || st === "ACCEPTED";
  });

  const current = await getEffectiveBillingPlan(shopDomain);

  if (activeSub) {
    const subscriptionName = String(activeSub.name ?? "");
    const planCode = planCodeFromSubscriptionName(subscriptionName);
    const subscriptionId =
      activeSub.id != null && String(activeSub.id).trim() !== "" ? String(activeSub.id) : null;

    if (planCode === "free" && subscriptionName.trim().length > 0) {
      log.warn(
        "subscription_name_unrecognized",
        `No plan mapping for subscription name: ${subscriptionName}`,
        { shopDomain, subscriptionName, source: "admin_reconcile" },
      );
    }

    const changed =
      current.planCode !== planCode ||
      current.status !== "active" ||
      (current.subscriptionId ?? null) !== subscriptionId;

    if (!changed) return;

    log.event("billing_plan_reconciled", {
      shopDomain,
      source: "admin_load",
      fromPlanCode: current.planCode,
      fromStatus: current.status,
      toPlanCode: planCode,
      toStatus: "active",
    });

    await updateShopPlan(shopDomain, planCode);
    await saveBillingPlan(shopDomain, {
      planCode,
      status: "active",
      subscriptionId,
    });
    return;
  }

  if (current.status === "active") {
    log.event("billing_plan_reconciled", {
      shopDomain,
      source: "admin_load",
      fromPlanCode: current.planCode,
      fromStatus: current.status,
      toPlanCode: "free",
      toStatus: "inactive",
    });
    await updateShopPlan(shopDomain, "free");
    await saveBillingPlan(shopDomain, {
      planCode: "free",
      status: "inactive",
      subscriptionId: null,
    });
  }
}

export async function incrementBillingUsage(shopDomain: string, incrementBy = 1): Promise<BillingPlan> {
  const plan = await getEffectiveBillingPlan(shopDomain);
  const nextUsage = Math.max(0, Number(plan.usageThisMonth || 0) + incrementBy);
  const nextPlan = {
    ...plan,
    usageThisMonth: nextUsage,
  };
  await saveBillingPlan(shopDomain, nextPlan);
  return {
    ...DEFAULT_BILLING_PLAN,
    ...nextPlan,
  };
}

export async function saveBillingPlan(shopDomain: string, plan: Partial<BillingPlan>): Promise<void> {
  await shopDoc(shopDomain).collection("billing").doc("plan").set(
    {
      ...DEFAULT_BILLING_PLAN,
      ...plan,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

export async function getAppSettings(shopDomain: string): Promise<AppSettings> {
  const shopSnapshot = await shopDoc(shopDomain).get();
  const shopData = shopSnapshot.data() as Partial<AppSettings> | undefined;

  if (!shopData) return DEFAULT_APP_SETTINGS;
  return {
    ...DEFAULT_APP_SETTINGS,
    ...shopData,
  };
}

export async function saveAppSettings(shopDomain: string, settings: Partial<AppSettings>): Promise<void> {
  await shopDoc(shopDomain).set(
    {
      ...settings,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

export async function computeDashboardStats(shopDomain: string): Promise<DashboardStats> {
  const [sessions, jobs] = await Promise.all([
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
  ]);

  const blockedUploads = sessions.filter((session) => session.status === "blocked").length;
  const convertedSessions = sessions.filter((session) => session.status === "converted").length;
  const storageUsedBytes = sessions.reduce((sum, session) => {
    return (
      sum +
      session.assets.reduce((assetSum, asset) => {
        return assetSum + Number(asset.sizeBytes || 0);
      }, 0)
    );
  }, 0);

  return {
    totalUploads: sessions.length,
    totalOrders: jobs.length,
    blockedUploads,
    estimatedConversionRate: sessions.length > 0 ? Math.round((convertedSessions / sessions.length) * 100) : 0,
    storageUsedMB: Math.round((storageUsedBytes / (1024 * 1024)) * 100) / 100,
  };
}

