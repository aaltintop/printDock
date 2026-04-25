# PrintDock — Full Firebase Technical Specification for Cursor AI
## "PrintDock — Artwork Upload & Pricing for Print Houses"
### 100% Firebase / Google Cloud Stack

---

## 1. FIREBASE STACK — COMPLETE REPLACEMENT

| Layer | Technology | Why |
|---|---|---|
| Framework | **Remix + TypeScript** | Same — Shopify recommended |
| Deploy | **Cloud Run** (Google Cloud) | Firebase Hosting can't run Node.js — Cloud Run always warm, no cold starts |
| Database | **Firestore** (Firebase Admin SDK) | Hierarchical shops/{shopId}/... structure |
| File Storage | **Firebase Storage** (via @google-cloud/storage) | Presigned upload URLs, same concept as S3 |
| Background jobs | **Cloud Run** (same server) | No separate Cloud Functions needed |
| Email | **Resend** | Firebase has no email service |
| Auth | **None** | Shopify handles OAuth |

**No Prisma. No PostgreSQL. No AWS. No Railway.**

---

## 2. PROJECT STRUCTURE

```
print-upload-app/
├── shopify.app.toml
├── package.json
├── .env
├── Dockerfile                        ← Cloud Run deploy
├── firebase.json                     ← Firebase project config
├── .firebaserc                       ← Firebase project alias
├── firestore.rules                   ← Security rules (server bypasses these)
├── firestore.indexes.json            ← Composite index definitions
├── storage.rules                     ← Firebase Storage security rules
├── app/
│   ├── root.tsx
│   ├── shopify.server.ts             ← Shopify app init
│   ├── firebase.server.ts            ← Firebase Admin SDK singleton
│   ├── services/
│   │   ├── storage.server.ts         ← Firebase Storage: presigned URLs
│   │   ├── firestore.server.ts       ← All Firestore CRUD helpers
│   │   ├── validation.server.ts      ← sharp + rule engine (unchanged)
│   │   ├── pricing.server.ts         ← Price calculation (unchanged)
│   │   ├── export.server.ts          ← ZIP with archiver (unchanged)
│   │   └── billing.server.ts         ← Shopify Billing API (unchanged)
│   ├── routes/
│   │   ├── app._index.tsx
│   │   ├── app.fields._index.tsx
│   │   ├── app.fields.$id.tsx
│   │   ├── app.orders._index.tsx
│   │   ├── app.orders.$id.tsx
│   │   ├── app.billing.tsx
│   │   ├── api.upload.session.tsx
│   │   ├── api.upload.confirm.tsx
│   │   ├── api.upload.restore.tsx
│   │   ├── api.reupload.$token.tsx
│   │   ├── api.jobs.$id.download.tsx
│   │   ├── api.jobs.$id.zip.tsx
│   │   ├── webhooks.orders-create.tsx
│   │   ├── webhooks.app-uninstalled.tsx
│   │   ├── webhooks.gdpr.customers-data-request.tsx
│   │   ├── webhooks.gdpr.customers-redact.tsx
│   │   └── webhooks.gdpr.shop-redact.tsx
│   └── utils/
│       └── hmac.server.ts
└── extensions/
    └── upload-block/
        ├── blocks/upload.liquid
        └── assets/
            ├── upload.js
            └── upload.css
```

---

## 3. ENVIRONMENT VARIABLES

```bash
# .env

SHOPIFY_API_KEY=                    # Partners panelinden
SHOPIFY_API_SECRET=                 # Webhook HMAC doğrulama için de kullanılır
SHOPIFY_APP_URL=                    # Cloud Run public URL: https://xxx.run.app

FIREBASE_PROJECT_ID=printdock-app  # Firebase Console'dan
FIREBASE_STORAGE_BUCKET=printdock-app.appspot.com

# Service Account JSON içeriği (tek satır stringify)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"..."}

RESEND_API_KEY=                     # Re-upload e-postaları için
```

---

## 4. FIRESTORE DATA STRUCTURE

```
shops/{shopDomain}/                        ← Tenant root (shopDomain = "mystore.myshopify.com")
  │
  ├── [Shop document]
  │     accessToken, planName, billingStatus, installedAt
  │
  ├── fields/{fieldId}                     ← Upload field config
  │     title, label, helpText
  │     isRequired, maxFiles, allowedTypes[], maxFileMB
  │     pricingMode, unitPrice, minPrice
  │     validationRules[]                  ← JSON array embedded in doc
  │     productIds[]
  │     status
  │     createdAt, updatedAt
  │
  ├── sessions/{token}                     ← token = document ID → instant lookup
  │   │   productId, variantId, customerId
  │   │   status, expiresAt, createdAt
  │   │
  │   └── assets/{assetId}
  │       │   storageKey, originalName, mimeType
  │       │   sizeBytes, widthPx, heightPx, dpi
  │       │   widthInch, heightInch, pageCount
  │       │   checksum, createdAt
  │       │
  │       └── validationResults/{resultId}
  │               ruleId, severity, message, details, createdAt
  │
  ├── jobs/{jobId}                         ← Post-order operational record
  │   │   shopifyOrderId, shopifyOrderName
  │   │   shopifyLineItemId, sessionToken
  │   │   productId, variantId
  │   │   assetsSnapshot                   ← Copy of asset data at order time
  │   │   pricingSnapshot
  │   │   lineItemPropsSnapshot
  │   │   status                           ← uploaded|validation_warning|pending_review|
  │   │                                       approved|reupload_requested|ready_for_production
  │   │   createdAt, updatedAt
  │   │
  │   ├── notes/{noteId}
  │   │       authorId, authorName, body, createdAt
  │   │
  │   └── reuploadRequests/{requestId}
  │           token                        ← token = document ID for instant lookup
  │           reason, status, expiresAt
  │           createdAt, completedAt
  │
  ├── billingPlan/plan                     ← Single document
  │       shopifySubscriptionId, planCode
  │       monthlyBaseFee, percentageRateBps
  │       usageCapAmount, currency, status
  │       currentPeriodStart, currentPeriodEnd
  │
  └── billableLines/{lineId}
          shopifyOrderId, lineItemId
          recognizedAmount, currency
          computedFee, roundedFee
          recognitionStatus
          recognizedAt, createdAt
```

---

## 5. NPM PACKAGES

```bash
# Production dependencies
npm install \
  @shopify/shopify-app-remix \
  @shopify/polaris \
  @shopify/app-bridge-react \
  firebase-admin \
  @google-cloud/storage \
  sharp \
  pdf-lib \
  archiver \
  resend \
  zod \
  uuid

# Dev dependencies
npm install -D \
  @shopify/cli \
  typescript \
  @types/archiver \
  @types/node \
  @types/uuid
```

**NOT: No prisma, no @prisma/client, no @aws-sdk packages.**

---

## 6. FIREBASE SETUP FILES

### 6.1 firebase.json

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "storage": {
    "rules": "storage.rules"
  }
}
```

### 6.2 .firebaserc

```json
{
  "projects": {
    "default": "printdock-app"
  }
}
```

### 6.3 firestore.rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // All access is via Firebase Admin SDK on the server
    // Admin SDK bypasses these rules entirely
    // These rules block any direct client-side access (security layer)
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 6.4 firestore.indexes.json

```json
{
  "indexes": [
    {
      "collectionGroup": "jobs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "jobs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "productId", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "jobs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "billableLines",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "recognitionStatus", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

### 6.5 storage.rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // All access via signed URLs — no client SDK direct access
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

---

## 7. CORE SERVICE FILES

### 7.1 app/firebase.server.ts — Admin SDK Singleton

```typescript
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

// Parse service account from environment variable
function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT!;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env var is not valid JSON");
  }
}

// Singleton pattern — critical for Remix/Cloud Run
if (!getApps().length) {
  initializeApp({
    credential: cert(getServiceAccount()),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

export const db = getFirestore();
export const storage = getStorage();
export const bucket = storage.bucket();

// Helper: shop document reference
export const shopRef = (shopDomain: string) =>
  db.collection("shops").doc(shopDomain);

// Helper: subcollection references
export const fieldsRef = (shopDomain: string) =>
  shopRef(shopDomain).collection("fields");

export const sessionsRef = (shopDomain: string) =>
  shopRef(shopDomain).collection("sessions");

export const jobsRef = (shopDomain: string) =>
  shopRef(shopDomain).collection("jobs");

export const billableLinesRef = (shopDomain: string) =>
  shopRef(shopDomain).collection("billableLines");
```

### 7.2 app/services/storage.server.ts — Firebase Storage

```typescript
import { bucket } from "~/firebase.server";
import { v4 as uuidv4 } from "uuid";

// Generate a presigned URL for direct browser → Firebase Storage upload
// Files NEVER pass through the app server — same architecture as S3 version
export async function getPresignedUploadUrl(
  shopDomain: string,
  sessionId: string,
  fileName: string,
  mimeType: string
): Promise<{ presignedUrl: string; storageKey: string }> {
  const ext = fileName.split(".").pop();
  const storageKey = `uploads/${shopDomain}/${sessionId}/${uuidv4()}.${ext}`;

  const file = bucket.file(storageKey);
  const [presignedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    contentType: mimeType,
  });

  return { presignedUrl, storageKey };
}

// Generate a time-limited signed URL for merchant to download
export async function getSignedDownloadUrl(
  storageKey: string,
  expiresInMs = 60 * 60 * 1000 // 1 hour
): Promise<string> {
  const file = bucket.file(storageKey);
  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInMs,
  });
  return signedUrl;
}

// Download file as Buffer — server-side only, for sharp validation
export async function getFileBuffer(storageKey: string): Promise<Buffer> {
  const file = bucket.file(storageKey);
  const [buffer] = await file.download();
  return buffer;
}

// Delete a file — called on session expiry or re-upload replacement
export async function deleteFile(storageKey: string): Promise<void> {
  const file = bucket.file(storageKey);
  await file.delete({ ignoreNotFound: true });
}
```

### 7.3 app/services/firestore.server.ts — All DB Operations

```typescript
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  db,
  shopRef,
  fieldsRef,
  sessionsRef,
  jobsRef,
  billableLinesRef,
} from "~/firebase.server";

// ─── TYPE DEFINITIONS ────────────────────────────────────────────────────────

export interface Shop {
  shopDomain: string;
  accessToken: string;
  planName?: string;
  billingStatus: "trial" | "active" | "cancelled";
  installedAt: Timestamp;
}

export interface UploadField {
  id?: string;
  title: string;
  label: string;
  helpText?: string;
  isRequired: boolean;
  maxFiles: number;
  allowedTypes: string[];
  maxFileMB: number;
  pricingMode?: "inch_height" | "inch_square" | "flat" | null;
  unitPrice?: number;
  minPrice?: number;
  validationRules: ValidationRule[];
  productIds: string[];
  status: "active" | "draft" | "archived";
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ValidationRule {
  id: string;
  type: "widthPx" | "heightPx" | "dpi" | "widthInch" | "heightInch" | "pageCount" | "fileSizeMB";
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  value: number;
  action: "blocking" | "warning";
  message: string;
}

export interface UploadSession {
  id?: string;
  token: string;
  productId: string;
  variantId?: string;
  customerId?: string;
  status: "active" | "converted" | "expired" | "abandoned";
  expiresAt: Timestamp;
  createdAt?: Timestamp;
}

export interface UploadAsset {
  id?: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  fileExtension: string;
  sizeBytes: number;
  widthPx?: number;
  heightPx?: number;
  dpi?: number;
  widthInch?: number;
  heightInch?: number;
  pageCount?: number;
  checksum: string;
  createdAt?: Timestamp;
}

export interface OrderJob {
  id?: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyLineItemId: string;
  sessionToken: string;
  productId: string;
  variantId?: string;
  assetsSnapshot: UploadAsset[];
  pricingSnapshot?: object;
  lineItemPropsSnapshot?: object;
  status:
    | "uploaded"
    | "validation_warning"
    | "pending_review"
    | "approved"
    | "reupload_requested"
    | "ready_for_production";
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// ─── SHOP ────────────────────────────────────────────────────────────────────

export async function upsertShop(shopDomain: string, data: Partial<Shop>) {
  await shopRef(shopDomain).set(
    { ...data, shopDomain, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

export async function getShop(shopDomain: string): Promise<Shop | null> {
  const doc = await shopRef(shopDomain).get();
  return doc.exists ? (doc.data() as Shop) : null;
}

// ─── UPLOAD FIELDS ───────────────────────────────────────────────────────────

export async function createField(
  shopDomain: string,
  data: Omit<UploadField, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  const ref = fieldsRef(shopDomain).doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getField(
  shopDomain: string,
  fieldId: string
): Promise<UploadField | null> {
  const doc = await fieldsRef(shopDomain).doc(fieldId).get();
  return doc.exists ? { id: doc.id, ...(doc.data() as UploadField) } : null;
}

export async function listFields(shopDomain: string): Promise<UploadField[]> {
  const snap = await fieldsRef(shopDomain)
    .where("status", "!=", "archived")
    .orderBy("status")
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as UploadField) }));
}

export async function updateField(
  shopDomain: string,
  fieldId: string,
  data: Partial<UploadField>
): Promise<void> {
  await fieldsRef(shopDomain)
    .doc(fieldId)
    .update({ ...data, updatedAt: FieldValue.serverTimestamp() });
}

export async function getFieldForProduct(
  shopDomain: string,
  productId: string
): Promise<UploadField | null> {
  const snap = await fieldsRef(shopDomain)
    .where("productIds", "array-contains", productId)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as UploadField) };
}

// ─── UPLOAD SESSIONS ─────────────────────────────────────────────────────────

export async function createSession(
  shopDomain: string,
  data: Omit<UploadSession, "id" | "createdAt">
): Promise<string> {
  // Use token as document ID for O(1) lookup
  const ref = sessionsRef(shopDomain).doc(data.token);
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return data.token;
}

export async function getSession(
  shopDomain: string,
  token: string
): Promise<UploadSession | null> {
  const doc = await sessionsRef(shopDomain).doc(token).get();
  return doc.exists ? { id: doc.id, ...(doc.data() as UploadSession) } : null;
}

export async function updateSessionStatus(
  shopDomain: string,
  token: string,
  status: UploadSession["status"]
): Promise<void> {
  await sessionsRef(shopDomain).doc(token).update({ status });
}

// ─── UPLOAD ASSETS ───────────────────────────────────────────────────────────

export async function createAsset(
  shopDomain: string,
  token: string,
  data: Omit<UploadAsset, "id" | "createdAt">
): Promise<string> {
  const ref = sessionsRef(shopDomain).doc(token).collection("assets").doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getSessionAssets(
  shopDomain: string,
  token: string
): Promise<UploadAsset[]> {
  const snap = await sessionsRef(shopDomain)
    .doc(token)
    .collection("assets")
    .orderBy("createdAt", "asc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as UploadAsset) }));
}

export async function saveValidationResults(
  shopDomain: string,
  token: string,
  assetId: string,
  results: Array<{
    ruleId: string;
    severity: "blocking" | "warning";
    message: string;
    actual: number | null;
    expected: number;
  }>
): Promise<void> {
  const batch = db.batch();
  const baseRef = sessionsRef(shopDomain)
    .doc(token)
    .collection("assets")
    .doc(assetId)
    .collection("validationResults");

  for (const result of results) {
    const ref = baseRef.doc();
    batch.set(ref, { ...result, createdAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
}

// ─── ORDER JOBS ──────────────────────────────────────────────────────────────

export async function createJob(
  shopDomain: string,
  data: Omit<OrderJob, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  // Check idempotency first
  const existing = await jobsRef(shopDomain)
    .where("shopifyOrderId", "==", data.shopifyOrderId)
    .where("shopifyLineItemId", "==", data.shopifyLineItemId)
    .limit(1)
    .get();

  if (!existing.empty) return existing.docs[0].id;

  const ref = jobsRef(shopDomain).doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getJob(
  shopDomain: string,
  jobId: string
): Promise<OrderJob | null> {
  const doc = await jobsRef(shopDomain).doc(jobId).get();
  return doc.exists ? { id: doc.id, ...(doc.data() as OrderJob) } : null;
}

export interface JobFilters {
  status?: string;
  productId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  orderNamePrefix?: string; // Prefix search — Firestore supports this
  limit?: number;
  startAfter?: FirebaseFirestore.DocumentSnapshot;
}

export async function listJobs(
  shopDomain: string,
  filters: JobFilters = {}
): Promise<{ jobs: OrderJob[]; lastDoc: FirebaseFirestore.DocumentSnapshot | null }> {
  let query: FirebaseFirestore.Query = jobsRef(shopDomain);

  if (filters.status) {
    query = query.where("status", "==", filters.status);
  }
  if (filters.productId) {
    query = query.where("productId", "==", filters.productId);
  }
  if (filters.dateFrom) {
    query = query.where("createdAt", ">=", Timestamp.fromDate(filters.dateFrom));
  }
  if (filters.dateTo) {
    query = query.where("createdAt", "<=", Timestamp.fromDate(filters.dateTo));
  }

  // Prefix search for order name (e.g. "#104" finds "#1042", "#1043")
  if (filters.orderNamePrefix) {
    const prefix = filters.orderNamePrefix;
    query = query
      .where("shopifyOrderName", ">=", prefix)
      .where("shopifyOrderName", "<=", prefix + "\uf8ff");
  }

  query = query.orderBy("createdAt", "desc").limit(filters.limit ?? 50);

  if (filters.startAfter) {
    query = query.startAfter(filters.startAfter);
  }

  const snap = await query.get();
  const jobs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as OrderJob) }));
  const lastDoc = snap.docs[snap.docs.length - 1] ?? null;

  return { jobs, lastDoc };
}

export async function updateJobStatus(
  shopDomain: string,
  jobId: string,
  status: OrderJob["status"]
): Promise<void> {
  await jobsRef(shopDomain).doc(jobId).update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ─── INTERNAL NOTES ──────────────────────────────────────────────────────────

export async function addNote(
  shopDomain: string,
  jobId: string,
  authorName: string,
  body: string
): Promise<string> {
  const ref = jobsRef(shopDomain).doc(jobId).collection("notes").doc();
  await ref.set({
    authorName,
    body,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function listNotes(
  shopDomain: string,
  jobId: string
): Promise<Array<{ id: string; authorName: string; body: string; createdAt: Timestamp }>> {
  const snap = await jobsRef(shopDomain)
    .doc(jobId)
    .collection("notes")
    .orderBy("createdAt", "asc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

// ─── RE-UPLOAD REQUESTS ──────────────────────────────────────────────────────

export async function createReuploadRequest(
  shopDomain: string,
  jobId: string,
  reason: string
): Promise<string> {
  const token = uuidv4().replace(/-/g, "");
  const ref = jobsRef(shopDomain).doc(jobId).collection("reuploadRequests").doc(token);
  await ref.set({
    token,
    reason,
    status: "open",
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)), // 7 days
    createdAt: FieldValue.serverTimestamp(),
  });
  return token;
}

export async function getReuploadRequest(
  shopDomain: string,
  jobId: string,
  token: string
) {
  // token = document ID for O(1) lookup
  const doc = await jobsRef(shopDomain)
    .doc(jobId)
    .collection("reuploadRequests")
    .doc(token)
    .get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// ─── BILLING ─────────────────────────────────────────────────────────────────

export async function getBillingPlan(shopDomain: string) {
  const doc = await shopRef(shopDomain)
    .collection("billingPlan")
    .doc("plan")
    .get();
  return doc.exists ? doc.data() : null;
}

export async function saveBillingPlan(shopDomain: string, data: object) {
  await shopRef(shopDomain)
    .collection("billingPlan")
    .doc("plan")
    .set(data, { merge: true });
}

export async function createBillableLine(
  shopDomain: string,
  data: object
): Promise<void> {
  const ref = billableLinesRef(shopDomain).doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function getBillableLineExists(
  shopDomain: string,
  orderId: string,
  lineItemId: string
): Promise<boolean> {
  const snap = await billableLinesRef(shopDomain)
    .where("shopifyOrderId", "==", orderId)
    .where("lineItemId", "==", lineItemId)
    .limit(1)
    .get();
  return !snap.empty;
}

// Firestore aggregation — sum all recognized amounts for current period
export async function getBillingPeriodTotal(
  shopDomain: string,
  periodStart: Date,
  periodEnd: Date
): Promise<number> {
  const { AggregateField } = await import("firebase-admin/firestore");

  const snap = await billableLinesRef(shopDomain)
    .where("recognitionStatus", "==", "recognized")
    .where("createdAt", ">=", Timestamp.fromDate(periodStart))
    .where("createdAt", "<=", Timestamp.fromDate(periodEnd))
    .aggregate({
      totalRevenue: AggregateField.sum("recognizedAmount"),
      totalFee: AggregateField.sum("roundedFee"),
    })
    .get();

  return snap.data().totalFee ?? 0;
}
```

### 7.4 app/services/validation.server.ts — Unchanged

Same as original spec — sharp and pdf-lib don't change.

### 7.5 app/services/pricing.server.ts — Unchanged

Same as original spec — pure calculation logic, no DB dependency.

### 7.6 app/services/export.server.ts — Updated for Firebase Storage

```typescript
import archiver from "archiver";
import { Readable } from "stream";
import { getFileBuffer } from "./storage.server";
import { getJob, listJobs } from "./firestore.server";

export async function createZipForJob(
  shopDomain: string,
  jobId: string
): Promise<Buffer> {
  const job = await getJob(shopDomain, jobId);
  if (!job) throw new Error("Job not found");

  const assets = job.assetsSnapshot as Array<{
    storageKey: string;
    originalName: string;
  }>;

  return buildZip(
    assets.map((a) => ({
      storageKey: a.storageKey,
      fileName: `${job.shopifyOrderName}/${a.originalName}`,
    }))
  );
}

export async function createBulkZip(
  shopDomain: string,
  jobIds: string[]
): Promise<Buffer> {
  const entries: { storageKey: string; fileName: string }[] = [];

  for (const jobId of jobIds) {
    const job = await getJob(shopDomain, jobId);
    if (!job) continue;
    const assets = job.assetsSnapshot as Array<{ storageKey: string; originalName: string }>;
    for (const asset of assets) {
      entries.push({
        storageKey: asset.storageKey,
        fileName: `${job.shopifyOrderName}/${asset.originalName}`,
      });
    }
  }

  return buildZip(entries);
}

async function buildZip(
  entries: { storageKey: string; fileName: string }[]
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    for (const entry of entries) {
      const buffer = await getFileBuffer(entry.storageKey);
      archive.append(Readable.from(buffer), { name: entry.fileName });
    }

    archive.finalize();
  });
}
```

### 7.7 app/services/billing.server.ts — Updated for Firestore

```typescript
import {
  getBillingPlan,
  saveBillingPlan,
  createBillableLine,
  getBillableLineExists,
  getJob,
} from "./firestore.server";

const PLANS = {
  starter: { monthlyFee: 19, percentageBps: 75, cap: 200 },
  growth:  { monthlyFee: 49, percentageBps: 50, cap: 500 },
  pro:     { monthlyFee: 99, percentageBps: 30, cap: 1000 },
} as const;

export async function createSubscription(
  admin: any,
  planCode: keyof typeof PLANS,
  returnUrl: string
) {
  const plan = PLANS[planCode];

  const response = await admin.graphql(`
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: false) {
        confirmationUrl
        appSubscription { id }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      name: `PrintDock ${planCode}`,
      returnUrl,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.monthlyFee, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
        {
          plan: {
            appUsagePricingDetails: {
              terms: `${plan.percentageBps / 100}% of uploader-generated sales`,
              cappedAmount: { amount: plan.cap, currencyCode: "USD" },
            },
          },
        },
      ],
    },
  });

  return response.json().data.appSubscriptionCreate;
}

export async function processBillableOrder(
  shopDomain: string,
  order: any
) {
  const billingPlan = await getBillingPlan(shopDomain);
  if (!billingPlan || billingPlan.status !== "active") return;

  for (const line of order.line_items) {
    const sessionToken = line.properties?.find(
      (p: any) => p.name === "_uc_session"
    )?.value;
    if (!sessionToken) continue;

    const orderId = String(order.id);
    const lineItemId = String(line.id);

    // Idempotency check
    const exists = await getBillableLineExists(shopDomain, orderId, lineItemId);
    if (exists) continue;

    const amount = parseFloat(line.price) * line.quantity;
    const computedFee = amount * (billingPlan.percentageRateBps / 10000);

    await createBillableLine(shopDomain, {
      shopifyOrderId: orderId,
      lineItemId,
      recognizedAmount: amount,
      currency: order.currency,
      computedFee,
      roundedFee: Math.round(computedFee * 100) / 100,
      recognitionStatus: "recognized",
    });
  }
}
```

---

## 8. API ROUTES

### 8.1 api.upload.session.tsx — Updated

```typescript
import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Timestamp } from "firebase-admin/firestore";
import { createSession } from "~/services/firestore.server";
import { getPresignedUploadUrl } from "~/services/storage.server";

const schema = z.object({
  shopDomain: z.string(),
  productId: z.string(),
  variantId: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string(),
});

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid input" }, { status: 400 });

  const { shopDomain, productId, variantId, fileName, mimeType } = parsed.data;

  // Generate unique token — this becomes the Firestore document ID
  const token = uuidv4().replace(/-/g, "");

  // Create session in Firestore
  await createSession(shopDomain, {
    token,
    productId,
    variantId,
    status: "active",
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 2 * 60 * 60 * 1000)),
  });

  // Get presigned upload URL from Firebase Storage
  const { presignedUrl, storageKey } = await getPresignedUploadUrl(
    shopDomain,
    token,
    fileName,
    mimeType
  );

  return json({ sessionToken: token, presignedUrl, storageKey });
}
```

### 8.2 api.upload.confirm.tsx — Updated

```typescript
import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import {
  getSession,
  getFieldForProduct,
  createAsset,
  saveValidationResults,
} from "~/services/firestore.server";
import { getFileBuffer } from "~/services/storage.server";
import {
  extractMetadata,
  runValidationRules,
  hasBlockingError,
} from "~/services/validation.server";
import { calculatePrice } from "~/services/pricing.server";

const schema = z.object({
  shopDomain: z.string(),
  sessionToken: z.string(),
  storageKey: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid input" }, { status: 400 });

  const { shopDomain, sessionToken, storageKey, originalName, mimeType, sizeBytes } = parsed.data;

  // Find session — O(1) lookup since token = doc ID
  const session = await getSession(shopDomain, sessionToken);
  if (!session) return json({ error: "Session not found" }, { status: 404 });
  if (session.status === "expired") return json({ error: "Session expired" }, { status: 410 });

  // Download file from Firebase Storage for validation
  const buffer = await getFileBuffer(storageKey);

  // Extract metadata with sharp / pdf-lib
  const metadata = await extractMetadata(buffer, mimeType, sizeBytes);

  // Find upload field config for this product
  const field = await getFieldForProduct(shopDomain, session.productId);

  // Run validation rules
  const rules = field?.validationRules ?? [];
  const validationResults = runValidationRules(metadata, rules);
  const blocked = hasBlockingError(validationResults);

  // Save asset to Firestore
  const assetId = await createAsset(shopDomain, sessionToken, {
    storageKey,
    originalName,
    mimeType,
    fileExtension: originalName.split(".").pop() ?? "",
    sizeBytes,
    widthPx: metadata.widthPx ?? undefined,
    heightPx: metadata.heightPx ?? undefined,
    dpi: metadata.dpi ?? undefined,
    widthInch: metadata.widthInch ?? undefined,
    heightInch: metadata.heightInch ?? undefined,
    pageCount: metadata.pageCount ?? undefined,
    checksum: "",
  });

  // Save validation results
  if (validationResults.length > 0) {
    await saveValidationResults(shopDomain, sessionToken, assetId, validationResults);
  }

  // Calculate price
  let pricing = null;
  if (field?.pricingMode && !blocked) {
    pricing = calculatePrice(metadata, {
      mode: field.pricingMode as any,
      unitPrice: field.unitPrice ?? 0,
      minPrice: field.minPrice ?? 0,
    });
  }

  return json({
    assetId,
    metadata,
    validationResults,
    blocked,
    pricing,
  });
}
```

### 8.3 webhooks.orders-create.tsx — Updated

```typescript
import type { ActionFunctionArgs } from "@remix-run/node";
import { verifyWebhookHmac } from "~/utils/hmac.server";
import { getShop, createJob, updateSessionStatus } from "~/services/firestore.server";
import { processBillableOrder } from "~/services/billing.server";

export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain") ?? "";

  // CRITICAL: Always verify
  const isValid = verifyWebhookHmac(rawBody, hmac, process.env.SHOPIFY_API_SECRET!);
  if (!isValid) return new Response("Unauthorized", { status: 401 });

  const order = JSON.parse(rawBody);

  const shop = await getShop(shopDomain);
  if (!shop) return new Response("Shop not found", { status: 404 });

  for (const line of order.line_items) {
    const props = line.properties ?? [];
    const sessionToken = props.find((p: any) => p.name === "_uc_session")?.value;
    if (!sessionToken) continue;

    // Create OrderJob (idempotent — createJob checks for duplicates)
    await createJob(shopDomain, {
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      shopifyLineItemId: String(line.id),
      sessionToken,
      productId: String(line.product_id),
      variantId: line.variant_id ? String(line.variant_id) : undefined,
      assetsSnapshot: [],   // filled from session in real impl
      lineItemPropsSnapshot: props,
      status: "uploaded",
    });

    // Mark session as converted
    await updateSessionStatus(shopDomain, sessionToken, "converted");
  }

  // Process billing
  await processBillableOrder(shopDomain, order);

  return new Response("OK", { status: 200 });
}
```

---

## 9. STOREFRONT — UPLOAD.JS

Same as original spec, with one change: `shopDomain` instead of `shopId`.

The `upload.js` file calls:
- `${APP_URL}/api/upload/session` with `shopDomain: Shopify.shop`
- `${APP_URL}/api/upload/confirm` with `shopDomain, sessionToken, storageKey`

The rest of `upload.js` (drag-drop, S3 PUT, cart injection) is **identical** to the original spec — only the storage service changes, not the upload mechanism. Browser still uploads via presigned URL, just to Firebase Storage instead of AWS S3.

**CORS for Firebase Storage** (set this in Google Cloud Console → Storage → Bucket → Edit CORS):

```json
[
  {
    "origin": ["*"],
    "method": ["PUT", "POST", "GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

---

## 10. SHOPIFY APP CONFIGURATION

### shopify.app.toml

```toml
name = "PrintDock"
client_id = "{{ SHOPIFY_API_KEY }}"
application_url = "{{ SHOPIFY_APP_URL }}"
embedded = true

[access_scopes]
scopes = "read_products,read_orders"

[auth]
redirect_urls = [
  "{{ SHOPIFY_APP_URL }}/auth/callback",
  "{{ SHOPIFY_APP_URL }}/auth/shopify/callback",
  "{{ SHOPIFY_APP_URL }}/api/auth/callback",
]

[webhooks]
api_version = "2024-10"

  [[webhooks.subscriptions]]
  topics = ["orders/create"]
  uri = "/webhooks/orders-create"

  [[webhooks.subscriptions]]
  topics = ["app/uninstalled"]
  uri = "/webhooks/app-uninstalled"

  [[webhooks.subscriptions]]
  topics = ["customers/data_request"]
  uri = "/webhooks/gdpr/customers-data-request"

  [[webhooks.subscriptions]]
  topics = ["customers/redact"]
  uri = "/webhooks/gdpr/customers-redact"

  [[webhooks.subscriptions]]
  topics = ["shop/redact"]
  uri = "/webhooks/gdpr/shop-redact"
```

---

## 11. DEPLOYMENT — CLOUD RUN

### Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

EXPOSE 3000
ENV PORT=3000
CMD ["npm", "start"]
```

### Deploy commands

```bash
# 1. Build and push to Google Container Registry
gcloud builds submit --tag gcr.io/printdock-app/printdock

# 2. Deploy to Cloud Run
gcloud run deploy printdock \
  --image gcr.io/printdock-app/printdock \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 1Gi \
  --set-env-vars SHOPIFY_API_KEY=xxx,SHOPIFY_API_SECRET=xxx,...
```

**`--min-instances 1`** — This is critical. Keeps one instance always warm → no cold starts on webhooks.

---

## 12. FIREBASE PROJECT SETUP STEPS

The user must do these manually in Firebase Console / Google Cloud:

### Step 1: Create Firebase Project
- console.firebase.google.com → Add project → "printdock-app"
- Enable Firestore (Native mode) → Region: europe-west1
- Enable Storage → Region: europe-west1

### Step 2: Service Account
- Project Settings → Service Accounts → Generate new private key
- Download JSON → stringify entire JSON → paste into `FIREBASE_SERVICE_ACCOUNT` env var

### Step 3: Enable Firestore
- Firestore → Create database → Native mode → europe-west1

### Step 4: Deploy indexes
```bash
firebase login
firebase deploy --only firestore:indexes
```

### Step 5: Firebase Storage CORS
```bash
# Save CORS config to cors.json then:
gsutil cors set cors.json gs://printdock-app.appspot.com
```

### Step 6: Enable Cloud Run API
- Google Cloud Console → APIs → Enable "Cloud Run Admin API"

---

## 13. WHAT CHANGES vs ORIGINAL SPEC

| Original (AWS/Supabase) | Firebase Version |
|---|---|
| `@prisma/client` + `prisma` | `firebase-admin` |
| `@aws-sdk/client-s3` | `@google-cloud/storage` (via firebase-admin) |
| `@aws-sdk/s3-request-presigner` | `file.getSignedUrl()` |
| `db.server.ts` (Prisma singleton) | `firebase.server.ts` (Admin SDK singleton) |
| `schema.prisma` (10 tables) | `firestore.server.ts` (collection helpers) |
| `storage.server.ts` (S3) | `storage.server.ts` (Firebase Storage) |
| `Railway.app` deploy | `Cloud Run` deploy |
| `DATABASE_URL` env var | `FIREBASE_SERVICE_ACCOUNT` env var |
| Supabase dashboard | Firebase Console |
| `npx prisma migrate dev` | No migration needed |

**Unchanged:**
- `validation.server.ts` — sharp + pdf-lib (identical)
- `pricing.server.ts` — pure calculation (identical)
- `billing.server.ts` — Shopify Billing API GraphQL (identical)
- `hmac.server.ts` — webhook verification (identical)
- `upload.liquid` + `upload.js` + `upload.css` — storefront (identical)
- All admin UI routes structure (same, just use firestore helpers instead of Prisma)
- `shopify.app.toml` (scopes, webhooks — identical)

---

## 14. KNOWN LIMITATION — NO TEXT SEARCH

Firestore does not support substring search. The operations center search works as:

**Prefix search only** — typing "#104" finds "#1042", "#1043" etc. (starts-with)
**No substring** — typing "john" in customer email does NOT work

For MVP this is acceptable. To add full text search later:
- Add Algolia or Typesense ($25–50/mo)
- On job write, index the document in Algolia
- Search UI calls Algolia, gets jobIds, fetches from Firestore

---

## 15. COST ESTIMATE — FIREBASE STACK

### Development phase:
- Firestore: $0 (free tier: 50K reads/day, 20K writes/day)
- Firebase Storage: $0 (5GB free)
- Cloud Run: $0 (2M requests/month free, 360K GB-seconds/month free)
- Resend: $0 (3K emails/month free)
- **Total: $0/month**

### Production (50 merchants):
- Firestore: ~$0–2 (small shops stay in free tier)
- Firebase Storage: ~$5–8 (file storage + egress)
- Cloud Run (min-instances=1): ~$10–15
- Resend: $0
- **Total: ~$15–25/month** (cheaper than AWS stack at this scale!)

### Production (200 merchants):
- Firestore: ~$5–15
- Firebase Storage: ~$20–30
- Cloud Run: ~$25–35
- Resend: $20 (Pro plan)
- **Total: ~$70–100/month**

---

## 16. WHAT SUCCESS LOOKS LIKE (same as original)

**Shopper flow:**
1. Opens product page → sees PrintDock upload zone
2. Drags PNG → presigned URL → uploaded directly to Firebase Storage
3. Sees dimensions + price immediately
4. Adds to cart → `_uc_session` in line item properties

**Merchant flow:**
1. Opens PrintDock admin → Operations Center
2. Finds order → sees file metadata, dimensions, DPI
3. Downloads file (signed Firebase Storage URL)
4. Changes status → Approved
5. Optionally: requests re-upload

**That's the MVP.**
