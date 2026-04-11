import { db } from "../firebase.server";
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
  monthlyUploadsLimit: 100,
  maxFileMBLimit: 50,
  allowAdvancedRules: false,
  allowAutoPricing: false,
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
  };
}

function normalizeField(docId: string, raw: unknown): UploadFieldConfig {
  const field = isRecord(raw) ? raw : {};
  return {
    id: docId,
    productId: String(field.productId ?? ""),
    productHandle: String(field.productHandle ?? ""),
    targetVariantIds: Array.isArray(field.targetVariantIds)
      ? field.targetVariantIds.map((value) => String(value))
      : [],
    isActive: field.isActive !== false,
    isRequired: Boolean(field.isRequired),
    adminTitle: String(field.adminTitle ?? "Upload Field"),
    storefrontTitle: String(field.storefrontTitle ?? "Upload your artwork"),
    storefrontDescription: String(
      field.storefrontDescription ?? "Upload your design file before checkout.",
    ),
    fileRenamingPattern: String(
      field.fileRenamingPattern ?? "{orderId}_{lineItemId}_{originalName}",
    ),
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
    planRequirement:
      field.planRequirement === "basic_plus" || field.planRequirement === "pro_plus"
        ? (field.planRequirement as "basic_plus" | "pro_plus")
        : "free",
    createdAt: toIsoDate(field.createdAt),
    updatedAt: toIsoDate(field.updatedAt),
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
    customerEmail: String(job.customerEmail ?? "N/A"),
    shippingAddress: isRecord(job.shippingAddress) ? job.shippingAddress : null,
    productId: String(job.productId ?? ""),
    variantId: String(job.variantId ?? ""),
    assetSnapshot: job.assetSnapshot ? normalizeAsset("asset_snapshot", job.assetSnapshot) : null,
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

export async function listUploadFields(shopDomain: string): Promise<UploadFieldConfig[]> {
  const nestedSnapshot = await fieldsCollection(shopDomain).get();
  if (!nestedSnapshot.empty) {
    return nestedSnapshot.docs.map((doc) => normalizeField(doc.id, doc.data()));
  }

  const legacySnapshot = await db
    .collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .get();
  return legacySnapshot.docs.map((doc) => normalizeField(doc.id, doc.data()));
}

export async function getUploadField(shopDomain: string, fieldId: string): Promise<UploadFieldConfig | null> {
  const nestedDoc = await fieldsCollection(shopDomain).doc(fieldId).get();
  if (nestedDoc.exists) {
    return normalizeField(nestedDoc.id, nestedDoc.data());
  }

  const legacyDoc = await db.collection("uploadFields").doc(fieldId).get();
  if (!legacyDoc.exists) return null;
  const legacyData = legacyDoc.data();
  if (!legacyData || legacyData.shopDomain !== shopDomain) return null;
  return normalizeField(fieldId, legacyData);
}

export async function getActiveFieldForProduct(
  shopDomain: string,
  productId: string,
  variantId: string,
): Promise<UploadFieldConfig | null> {
  const nestedSnapshot = await fieldsCollection(shopDomain)
    .where("productId", "==", productId)
    .where("isActive", "==", true)
    .limit(15)
    .get();

  const nestedFields = nestedSnapshot.docs.map((doc) => normalizeField(doc.id, doc.data()));
  if (nestedFields.length > 0) {
    const matched =
      nestedFields.find(
        (field) =>
          field.targetVariantIds.length === 0 || field.targetVariantIds.includes(variantId),
      ) ?? nestedFields[0];
    return matched ?? null;
  }

  const legacySnapshot = await db
    .collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .where("productId", "==", productId)
    .where("isActive", "==", true)
    .limit(15)
    .get();
  const legacyFields = legacySnapshot.docs.map((doc) => normalizeField(doc.id, doc.data()));
  const matchedLegacy =
    legacyFields.find(
      (field) => field.targetVariantIds.length === 0 || field.targetVariantIds.includes(variantId),
    ) ?? legacyFields[0];
  return matchedLegacy ?? null;
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

export async function getBillingPlan(shopDomain: string): Promise<BillingPlan> {
  const nestedDoc = await shopDoc(shopDomain).collection("billing").doc("plan").get();
  if (nestedDoc.exists) {
    return {
      ...DEFAULT_BILLING_PLAN,
      ...(nestedDoc.data() as Partial<BillingPlan>),
    };
  }

  const legacyDoc = await db.collection("billingPlans").doc(shopDomain).get();
  if (!legacyDoc.exists) return DEFAULT_BILLING_PLAN;
  const legacyData = legacyDoc.data() as Partial<BillingPlan>;
  return {
    ...DEFAULT_BILLING_PLAN,
    ...legacyData,
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

