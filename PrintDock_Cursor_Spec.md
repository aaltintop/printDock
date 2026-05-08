# PrintDock — Full Technical Specification for Cursor AI
## "PrintDock — Artwork Upload & Pricing for Print Houses"
### A Public Shopify App for DTF / Gang Sheet Print Businesses

---

## 1. WHAT WE ARE BUILDING

PrintDock is a **public Shopify app** that solves a specific problem for print-house merchants:
- Shoppers must be able to upload PNG/PDF artwork files **directly on the product page** before adding to cart
- Files must be validated against print-specific rules (pixel dimensions, DPI, physical inch size)
- Prices must be automatically calculated based on the artwork's physical dimensions (Gang Sheet pricing: $/inch or $/inch²)
- After an order is placed, merchants need an **operations center** to manage, download, approve, and request re-uploads of artwork files

**The #1 competitor (Quaflow Upload Center, $9–59/mo) has no operations center at all.** Our operations layer is the primary differentiator.

---

## 2. TECH STACK — DO NOT DEVIATE

| Layer | Technology | Why |
|---|---|---|
| Framework | **Remix + TypeScript** | Shopify's recommended stack, SSR, loader/action pattern |
| Shopify SDK | **@shopify/shopify-app-remix** | OAuth, session, webhook management |
| Admin UI | **@shopify/polaris + @shopify/app-bridge-react** | Native Shopify embedded app look |
| Storefront | **Theme App Extension** (Liquid + vanilla JS) | Product page upload block |
| Database | **PostgreSQL via Prisma** | Start with Supabase (dev), Railway Postgres (prod) |
| ORM | **Prisma** | Type-safe queries, auto migrations |
| File Storage | **AWS S3** — region: eu-central-1 (Frankfurt) | GDPR compliant, presigned URLs |
| AWS SDK | **@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner** | Direct browser-to-S3 upload |
| PNG/PDF parsing | **sharp** (PNG/JPEG) + **pdf-lib** (PDF) | Extract pixel dimensions, DPI, physical size |
| ZIP export | **archiver** | Bulk download for production operators |
| Email | **Resend** | Re-upload request notifications |
| Validation | **zod** | API input validation |
| Deploy | **Railway.app** | Simple Git-push deploy |

---

## 3. PROJECT STRUCTURE — CREATE EXACTLY THIS

```
print-upload-app/
├── shopify.app.toml              ← Shopify app config (scopes, webhooks, extensions)
├── package.json
├── .env                          ← Never commit
├── Dockerfile                    ← Railway deploy
├── prisma/
│   ├── schema.prisma             ← All 10 DB models
│   └── migrations/               ← Auto-generated
├── app/
│   ├── root.tsx                  ← Remix root
│   ├── shopify.server.ts         ← Shopify app init
│   ├── db.server.ts              ← Prisma client singleton
│   ├── services/
│   │   ├── storage.server.ts     ← AWS S3 operations
│   │   ├── validation.server.ts  ← sharp + rule engine
│   │   ├── pricing.server.ts     ← Price calculation logic
│   │   ├── export.server.ts      ← ZIP export with archiver
│   │   └── billing.server.ts     ← Shopify Billing API
│   ├── routes/
│   │   ├── app._index.tsx        ← Dashboard home
│   │   ├── app.fields._index.tsx ← Fields list
│   │   ├── app.fields.$id.tsx    ← Create / edit field
│   │   ├── app.orders._index.tsx ← Operations center (job list)
│   │   ├── app.orders.$id.tsx    ← Job detail page
│   │   ├── app.billing.tsx       ← Plan management
│   │   ├── api.upload.session.tsx      ← POST: create session + presigned URL
│   │   ├── api.upload.confirm.tsx      ← POST: validate + price after upload
│   │   ├── api.upload.restore.tsx      ← GET: session recovery
│   │   ├── api.reupload.$token.tsx     ← GET+POST: customer re-upload page
│   │   ├── api.jobs.$id.download.tsx   ← GET: signed download URL
│   │   ├── api.jobs.$id.zip.tsx        ← GET: ZIP export
│   │   ├── webhooks.orders-create.tsx
│   │   ├── webhooks.app-uninstalled.tsx
│   │   ├── webhooks.gdpr.customers-data-request.tsx
│   │   ├── webhooks.gdpr.customers-redact.tsx
│   │   └── webhooks.gdpr.shop-redact.tsx
│   └── utils/
│       ├── hmac.server.ts        ← Webhook signature verification
│       └── helpers.ts            ← Shared utilities
└── extensions/
    ├── upload-block/             ← Theme App Extension
    │   ├── blocks/
    │   │   └── upload.liquid     ← Product page block
    │   └── assets/
    │       ├── upload.js         ← All storefront JS logic
    │       └── upload.css        ← Upload UI styles
    └── cart-validation/          ← Shopify Function (optional V1)
```

---

## 4. ENVIRONMENT VARIABLES

```bash
# .env — fill these in, never commit

SHOPIFY_API_KEY=                  # From Partners panel — App Client ID
SHOPIFY_API_SECRET=               # From Partners panel — also used for HMAC webhook verification
SHOPIFY_APP_URL=                  # Your Railway public URL: https://xxx.railway.app

DATABASE_URL=                     # Supabase: postgresql://postgres:PASS@db.XXX.supabase.co:5432/postgres

AWS_ACCESS_KEY_ID=                # IAM user access key
AWS_SECRET_ACCESS_KEY=            # IAM user secret — never expose
AWS_REGION=eu-central-1           # Frankfurt — GDPR
S3_BUCKET=printdock-files         # Your bucket name

RESEND_API_KEY=                   # For re-upload notification emails
```

---

## 5. DATABASE SCHEMA — prisma/schema.prisma

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Shop {
  id            String   @id @default(cuid())
  shopifyShopId String   @unique
  shopDomain    String   @unique
  accessToken   String
  planName      String?
  billingStatus String   @default("trial") // trial | active | cancelled
  installedAt   DateTime @default(now())
  uninstalledAt DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  fields        UploadField[]
  sessions      UploadSession[]
  jobs          OrderJob[]
  billingPlan   BillingPlan?
}

model UploadField {
  id              String   @id @default(cuid())
  shopId          String
  shop            Shop     @relation(fields: [shopId], references: [id])
  title           String                        // Internal name, visible only in admin
  label           String   @default("Upload your artwork")  // Shown to customer
  helpText        String?                       // Instructions shown below upload zone
  isRequired      Boolean  @default(true)
  maxFiles        Int      @default(1)
  allowedTypes    String[] @default(["image/png"])  // MIME types
  maxFileMB       Float    @default(50)
  status          String   @default("active")   // active | draft | archived
  productIds      String[]                      // Shopify product GIDs this field applies to
  // Pricing config
  pricingMode     String?                       // inch_height | inch_square | flat | null
  unitPrice       Float?                        // Price per unit
  minPrice        Float?                        // Minimum charge regardless of size
  // Validation rules stored as JSON array
  validationRules Json     @default("[]")
  // Display
  showPreview     Boolean  @default(true)
  showDimensions  Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

// validationRules JSON structure (array of these):
// {
//   id: string,
//   type: "widthPx"|"heightPx"|"dpi"|"widthInch"|"heightInch"|"pageCount"|"fileSizeMB",
//   operator: "gt"|"lt"|"eq"|"gte"|"lte",
//   value: number,
//   action: "blocking"|"warning",
//   message: string  // shown to customer
// }

model UploadSession {
  id          String        @id @default(cuid())
  shopId      String
  shop        Shop          @relation(fields: [shopId], references: [id])
  token       String        @unique @default(cuid())
  productId   String                              // Shopify product GID
  variantId   String?                             // Shopify variant GID
  customerId  String?                             // Shopify customer GID if logged in
  status      String        @default("active")    // active | converted | expired | abandoned
  expiresAt   DateTime
  createdAt   DateTime      @default(now())
  assets      UploadAsset[]
  orderJob    OrderJob?
}

model UploadAsset {
  id               String        @id @default(cuid())
  sessionId        String
  session          UploadSession @relation(fields: [sessionId], references: [id])
  s3Key            String        @unique
  originalName     String
  normalizedName   String?       // Renamed according to merchant's pattern
  mimeType         String
  fileExtension    String
  sizeBytes        Int
  // Extracted by sharp / pdf-lib
  widthPx          Int?
  heightPx         Int?
  dpi              Float?
  widthInch        Float?
  heightInch       Float?
  pageCount        Int?          // PDF only
  previewS3Key     String?       // Thumbnail key
  checksum         String        // MD5 or SHA256
  createdAt        DateTime      @default(now())

  validationResults ValidationResult[]
}

model ValidationResult {
  id        String      @id @default(cuid())
  assetId   String
  asset     UploadAsset @relation(fields: [assetId], references: [id])
  ruleId    String
  severity  String      // "blocking" | "warning" | "info"
  message   String
  details   Json?
  createdAt DateTime    @default(now())
}

model OrderJob {
  id              String        @id @default(cuid())
  shopId          String
  shop            Shop          @relation(fields: [shopId], references: [id])
  shopifyOrderId  String
  shopifyOrderName String                          // e.g. "#1042"
  shopifyLineItemId String
  sessionId       String?       @unique
  session         UploadSession? @relation(fields: [sessionId], references: [id])
  customerId      String?
  productId       String
  variantId       String?
  // Snapshot at time of order
  assetsSnapshot  Json                            // Copy of asset data
  pricingSnapshot Json?                           // Price calculation at order time
  lineItemPropsSnapshot Json?                     // Raw Shopify line item properties
  status          String        @default("uploaded")
  // Status values:
  // uploaded | validation_warning | pending_review | approved | reupload_requested | ready_for_production
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  notes           InternalNote[]
  reuploadRequests ReuploadRequest[]
  billableLine    BillableOrderLine?
}

model InternalNote {
  id         String   @id @default(cuid())
  jobId      String
  job        OrderJob @relation(fields: [jobId], references: [id])
  authorId   String?  // Shopify user ID
  authorName String?
  body       String
  createdAt  DateTime @default(now())
}

model ReuploadRequest {
  id        String   @id @default(cuid())
  jobId     String
  job       OrderJob @relation(fields: [jobId], references: [id])
  token     String   @unique @default(cuid())
  reason    String?
  status    String   @default("open")  // open | completed | expired | cancelled
  expiresAt DateTime
  createdAt DateTime @default(now())
  completedAt DateTime?
}

model BillingPlan {
  id                    String   @id @default(cuid())
  shopId                String   @unique
  shop                  Shop     @relation(fields: [shopId], references: [id])
  shopifySubscriptionId String   @unique
  planCode              String   // starter | growth | pro
  monthlyBaseFee        Float
  percentageRateBps     Int      // basis points, e.g. 75 = 0.75%
  usageCapAmount        Float
  currency              String   @default("USD")
  status                String   @default("active")
  currentPeriodStart    DateTime
  currentPeriodEnd      DateTime
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  billableLines BillableOrderLine[]
}

model BillableOrderLine {
  id                String      @id @default(cuid())
  shopId            String
  jobId             String      @unique
  job               OrderJob    @relation(fields: [jobId], references: [id])
  billingPlanId     String
  plan              BillingPlan @relation(fields: [billingPlanId], references: [id])
  shopifyOrderId    String
  lineItemId        String
  recognizedAmount  Float       // The sale amount to calculate % on
  currency          String
  computedFee       Float       // recognizedAmount * (percentageRateBps / 10000)
  roundedFee        Float
  recognitionStatus String      @default("pending")
  // pending | recognized | excluded | adjusted
  exclusionReason   String?
  recognizedAt      DateTime?
  createdAt         DateTime    @default(now())
}
```

---

## 6. SHOPIFY APP CONFIG — shopify.app.toml

```toml
name = "PrintDock"
client_id = "{{ SHOPIFY_API_KEY }}"
application_url = "{{ SHOPIFY_APP_URL }}"
embedded = true

[access_scopes]
scopes = "read_products,read_orders,write_files"

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

[pos]
embedded = false
```

---

## 7. SERVICE FILES — WRITE THESE EXACTLY

### 7.1 app/services/storage.server.ts

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET!;

// Generate a presigned URL for the browser to upload directly to S3
// Files NEVER pass through the app server — this is critical for performance
export async function getPresignedUploadUrl(
  shopId: string,
  sessionId: string,
  fileName: string,
  mimeType: string
): Promise<{ presignedUrl: string; s3Key: string }> {
  const ext = fileName.split(".").pop();
  const s3Key = `uploads/${shopId}/${sessionId}/${Date.now()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: mimeType,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes
  return { presignedUrl, s3Key };
}

// Generate a time-limited signed URL for merchant to download a file
export async function getSignedDownloadUrl(
  s3Key: string,
  expiresIn = 3600  // 1 hour default
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(s3, command, { expiresIn });
}

// Get file as Buffer — used only server-side for sharp validation
export async function getFileBuffer(s3Key: string): Promise<Buffer> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: s3Key });
  const response = await s3.send(command);
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Delete a file from S3 — used on session expiry or re-upload replacement
export async function deleteFile(s3Key: string): Promise<void> {
  const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: s3Key });
  await s3.send(command);
}
```

### 7.2 app/services/validation.server.ts

```typescript
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

export interface FileMetadata {
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  widthInch: number | null;
  heightInch: number | null;
  pageCount: number | null;
  fileSizeMB: number;
}

export interface ValidationRule {
  id: string;
  type: "widthPx" | "heightPx" | "dpi" | "widthInch" | "heightInch" | "pageCount" | "fileSizeMB";
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  value: number;
  action: "blocking" | "warning";
  message: string;
}

export interface ValidationResult {
  ruleId: string;
  severity: "blocking" | "warning";
  message: string;
  actual: number | null;
  expected: number;
}

// Extract metadata from PNG/JPEG using sharp
export async function extractMetadata(
  buffer: Buffer,
  mimeType: string,
  fileSizeBytes: number
): Promise<FileMetadata> {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") {
    const meta = await sharp(buffer).metadata();
    const dpi = meta.density ?? null;
    return {
      widthPx: meta.width ?? null,
      heightPx: meta.height ?? null,
      dpi,
      // Physical size only calculable if DPI is embedded in file
      widthInch: dpi && meta.width ? Math.round((meta.width / dpi) * 100) / 100 : null,
      heightInch: dpi && meta.height ? Math.round((meta.height / dpi) * 100) / 100 : null,
      pageCount: null,
      fileSizeMB: Math.round(fileSizeMB * 100) / 100,
    };
  }

  if (mimeType === "application/pdf") {
    const pdf = await PDFDocument.load(buffer);
    const pages = pdf.getPages();
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize(); // in PDF points (1 point = 1/72 inch)
    return {
      widthPx: null,
      heightPx: null,
      dpi: 72, // PDF native
      widthInch: Math.round((width / 72) * 100) / 100,
      heightInch: Math.round((height / 72) * 100) / 100,
      pageCount: pages.length,
      fileSizeMB: Math.round(fileSizeMB * 100) / 100,
    };
  }

  // Unsupported type — return basic info
  return {
    widthPx: null, heightPx: null, dpi: null,
    widthInch: null, heightInch: null, pageCount: null,
    fileSizeMB: Math.round(fileSizeMB * 100) / 100,
  };
}

// Run all merchant-configured validation rules against file metadata
export function runValidationRules(
  metadata: FileMetadata,
  rules: ValidationRule[]
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const rule of rules) {
    const actual = metadata[rule.type] as number | null;
    if (actual === null) continue; // Can't check what we don't have

    const triggered = checkOperator(actual, rule.operator, rule.value);
    if (triggered) {
      results.push({
        ruleId: rule.id,
        severity: rule.action,
        message: rule.message,
        actual,
        expected: rule.value,
      });
    }
  }

  return results;
}

function checkOperator(actual: number, operator: string, expected: number): boolean {
  switch (operator) {
    case "gt":  return actual > expected;
    case "lt":  return actual < expected;
    case "eq":  return actual === expected;
    case "gte": return actual >= expected;
    case "lte": return actual <= expected;
    default:    return false;
  }
}

export function hasBlockingError(results: ValidationResult[]): boolean {
  return results.some((r) => r.severity === "blocking");
}
```

### 7.3 app/services/pricing.server.ts

```typescript
import type { FileMetadata } from "./validation.server";

export type PricingMode = "inch_height" | "inch_square" | "flat" | null;

export interface PricingConfig {
  mode: PricingMode;
  unitPrice: number;
  minPrice: number;
}

export interface PricingResult {
  filePrice: number;
  total: number;
  explanation: string;
  currency: string;
}

export function calculatePrice(
  metadata: FileMetadata,
  config: PricingConfig,
  quantity = 1,
  currency = "USD"
): PricingResult {
  const { mode, unitPrice, minPrice } = config;
  let rawPrice = 0;
  let explanation = "";

  switch (mode) {
    case "inch_height":
      if (metadata.heightInch) {
        rawPrice = metadata.heightInch * unitPrice;
        explanation = `${metadata.heightInch.toFixed(2)}" height × $${unitPrice}/inch`;
      }
      break;
    case "inch_square":
      if (metadata.widthInch && metadata.heightInch) {
        const area = metadata.widthInch * metadata.heightInch;
        rawPrice = area * unitPrice;
        explanation = `${metadata.widthInch.toFixed(2)}" × ${metadata.heightInch.toFixed(2)}" = ${area.toFixed(2)} in² × $${unitPrice}/in²`;
      }
      break;
    case "flat":
      rawPrice = unitPrice;
      explanation = `Flat rate: $${unitPrice}`;
      break;
    default:
      return { filePrice: 0, total: 0, explanation: "No pricing configured", currency };
  }

  // Apply minimum price floor
  const filePrice = Math.max(rawPrice, minPrice);
  if (rawPrice < minPrice && rawPrice > 0) {
    explanation += ` (minimum $${minPrice} applied)`;
  }

  const total = Math.round(filePrice * quantity * 100) / 100;

  return {
    filePrice: Math.round(filePrice * 100) / 100,
    total,
    explanation: quantity > 1 ? `${explanation} × ${quantity}` : explanation,
    currency,
  };
}

// Calculate price for multiple files in one session
export function calculateBatchPrice(
  files: { metadata: FileMetadata; quantity: number }[],
  config: PricingConfig,
  currency = "USD"
): { total: number; perFile: PricingResult[] } {
  const perFile = files.map((f) => calculatePrice(f.metadata, config, f.quantity, currency));
  const total = Math.round(perFile.reduce((sum, r) => sum + r.total, 0) * 100) / 100;
  return { total, perFile };
}
```

### 7.4 app/services/export.server.ts

```typescript
import archiver from "archiver";
import { Readable } from "stream";
import { getFileBuffer } from "./storage.server";
import { db } from "~/db.server";

// Create a ZIP archive for all files in a single order job
export async function createZipForJob(jobId: string): Promise<Buffer> {
  const job = await db.orderJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const assets = job.assetsSnapshot as Array<{
    s3Key: string;
    originalName: string;
  }>;

  return buildZip(
    assets.map((a) => ({
      s3Key: a.s3Key,
      fileName: `${job.shopifyOrderName}/${a.originalName}`,
    }))
  );
}

// Create a ZIP archive for multiple jobs at once (bulk export)
export async function createBulkZip(jobIds: string[]): Promise<Buffer> {
  const jobs = await db.orderJob.findMany({ where: { id: { in: jobIds } } });

  const entries: { s3Key: string; fileName: string }[] = [];
  for (const job of jobs) {
    const assets = job.assetsSnapshot as Array<{ s3Key: string; originalName: string }>;
    for (const asset of assets) {
      entries.push({
        s3Key: asset.s3Key,
        fileName: `${job.shopifyOrderName}/${asset.originalName}`,
      });
    }
  }

  return buildZip(entries);
}

async function buildZip(entries: { s3Key: string; fileName: string }[]): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    for (const entry of entries) {
      const buffer = await getFileBuffer(entry.s3Key);
      archive.append(Readable.from(buffer), { name: entry.fileName });
    }

    archive.finalize();
  });
}
```

### 7.5 app/services/billing.server.ts

```typescript
import { db } from "~/db.server";

const PLANS = {
  starter: { monthlyFee: 19, percentageBps: 75, cap: 200 },  // 0.75%
  growth:  { monthlyFee: 49, percentageBps: 50, cap: 500 },  // 0.50%
  pro:     { monthlyFee: 99, percentageBps: 30, cap: 1000 }, // 0.30%
} as const;

// Create a Shopify app subscription (recurring + usage) via GraphQL
export async function createSubscription(
  admin: any, // Shopify GraphQL admin client
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
      name: `PrintDock ${planCode.charAt(0).toUpperCase() + planCode.slice(1)}`,
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

  const data = response.json();
  return data.data.appSubscriptionCreate;
}

// Called after orders/create webhook — record billable line items
export async function processBillableOrder(
  shopId: string,
  order: any // Shopify order payload
) {
  const billingPlan = await db.billingPlan.findUnique({ where: { shopId } });
  if (!billingPlan || billingPlan.status !== "active") return;

  for (const line of order.line_items) {
    const sessionToken = line.properties?.find(
      (p: any) => p.name === "_uc_session"
    )?.value;

    if (!sessionToken) continue;

    // Find the job created for this line
    const job = await db.orderJob.findFirst({
      where: { shopifyOrderId: String(order.id), shopifyLineItemId: String(line.id) },
    });

    if (!job) continue;

    // Idempotency: don't double-bill
    const existing = await db.billableOrderLine.findUnique({ where: { jobId: job.id } });
    if (existing) continue;

    const amount = parseFloat(line.price) * line.quantity;
    const computedFee = amount * (billingPlan.percentageRateBps / 10000);

    await db.billableOrderLine.create({
      data: {
        shopId,
        jobId: job.id,
        billingPlanId: billingPlan.id,
        shopifyOrderId: String(order.id),
        lineItemId: String(line.id),
        recognizedAmount: amount,
        currency: order.currency,
        computedFee,
        roundedFee: Math.round(computedFee * 100) / 100,
        recognitionStatus: "recognized",
        recognizedAt: new Date(),
      },
    });
  }
}
```

---

## 8. API ROUTES — WRITE THESE EXACTLY

### 8.1 app/routes/api.upload.session.tsx

```typescript
import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { db } from "~/db.server";
import { getPresignedUploadUrl } from "~/services/storage.server";

const schema = z.object({
  shopId: z.string(),
  productId: z.string(),
  variantId: z.string().optional(),
  fileName: z.string(),
  mimeType: z.string(),
});

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid input" }, { status: 400 });

  const { shopId, productId, variantId, fileName, mimeType } = parsed.data;

  // Create session in DB
  const session = await db.uploadSession.create({
    data: {
      shopId,
      productId,
      variantId,
      status: "active",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
    },
  });

  // Generate presigned URL for direct browser → S3 upload
  const { presignedUrl, s3Key } = await getPresignedUploadUrl(
    shopId,
    session.id,
    fileName,
    mimeType
  );

  return json({
    sessionToken: session.token,
    sessionId: session.id,
    presignedUrl,
    s3Key,
  });
}
```

### 8.2 app/routes/api.upload.confirm.tsx

```typescript
import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { db } from "~/db.server";
import { getFileBuffer } from "~/services/storage.server";
import { extractMetadata, runValidationRules, hasBlockingError } from "~/services/validation.server";
import { calculatePrice } from "~/services/pricing.server";

const schema = z.object({
  sessionToken: z.string(),
  s3Key: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid input" }, { status: 400 });

  const { sessionToken, s3Key, originalName, mimeType, sizeBytes } = parsed.data;

  // Find session
  const session = await db.uploadSession.findUnique({
    where: { token: sessionToken },
  });
  if (!session) return json({ error: "Session not found" }, { status: 404 });
  if (session.status === "expired") return json({ error: "Session expired" }, { status: 410 });

  // Get file from S3 for server-side validation only
  const buffer = await getFileBuffer(s3Key);

  // Extract metadata with sharp / pdf-lib
  const metadata = await extractMetadata(buffer, mimeType, sizeBytes);

  // Find field config for this product
  const field = await db.uploadField.findFirst({
    where: {
      shopId: session.shopId,
      productIds: { has: session.productId },
      status: "active",
    },
  });

  // Run validation rules
  const rules = field?.validationRules as any[] ?? [];
  const validationResults = runValidationRules(metadata, rules);
  const blocked = hasBlockingError(validationResults);

  // Save asset to DB
  const asset = await db.uploadAsset.create({
    data: {
      sessionId: session.id,
      s3Key,
      originalName,
      mimeType,
      fileExtension: originalName.split(".").pop() ?? "",
      sizeBytes,
      widthPx: metadata.widthPx,
      heightPx: metadata.heightPx,
      dpi: metadata.dpi,
      widthInch: metadata.widthInch,
      heightInch: metadata.heightInch,
      pageCount: metadata.pageCount,
      checksum: "",
    },
  });

  // Save validation results
  if (validationResults.length > 0) {
    await db.validationResult.createMany({
      data: validationResults.map((r) => ({
        assetId: asset.id,
        ruleId: r.ruleId,
        severity: r.severity,
        message: r.message,
        details: { actual: r.actual, expected: r.expected },
      })),
    });
  }

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

  return json({
    assetId: asset.id,
    metadata,
    validationResults,
    blocked,
    pricing,
  });
}
```

### 8.3 app/routes/api.upload.restore.tsx

```typescript
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { db } from "~/db.server";
import { getSignedDownloadUrl } from "~/services/storage.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return json({ error: "Token required" }, { status: 400 });

  const session = await db.uploadSession.findUnique({
    where: { token },
    include: { assets: { include: { validationResults: true } } },
  });

  if (!session || session.status === "expired") {
    return json({ error: "Session not found or expired" }, { status: 404 });
  }

  // Generate signed preview URLs for each asset
  const assets = await Promise.all(
    session.assets.map(async (asset) => ({
      ...asset,
      previewUrl: await getSignedDownloadUrl(asset.s3Key, 3600),
    }))
  );

  return json({ session: { ...session, assets } });
}
```

### 8.4 app/routes/webhooks.orders-create.tsx

```typescript
import type { ActionFunctionArgs } from "@remix-run/node";
import { db } from "~/db.server";
import { verifyWebhookHmac } from "~/utils/hmac.server";
import { processBillableOrder } from "~/services/billing.server";

export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain") ?? "";

  // CRITICAL: Always verify webhook authenticity
  const isValid = verifyWebhookHmac(rawBody, hmac, process.env.SHOPIFY_API_SECRET!);
  if (!isValid) return new Response("Unauthorized", { status: 401 });

  const order = JSON.parse(rawBody);

  // Find shop in DB
  const shop = await db.shop.findUnique({ where: { shopDomain } });
  if (!shop) return new Response("Shop not found", { status: 404 });

  // Process each line item
  for (const line of order.line_items) {
    const props = line.properties ?? [];
    const sessionToken = props.find((p: any) => p.name === "_uc_session")?.value;
    if (!sessionToken) continue;

    // Find the session
    const session = await db.uploadSession.findUnique({
      where: { token: sessionToken },
      include: { assets: true },
    });
    if (!session) continue;

    // Idempotency: don't create duplicate jobs
    const existing = await db.orderJob.findFirst({
      where: {
        shopifyOrderId: String(order.id),
        shopifyLineItemId: String(line.id),
      },
    });
    if (existing) continue;

    // Create the OrderJob
    await db.orderJob.create({
      data: {
        shopId: shop.id,
        shopifyOrderId: String(order.id),
        shopifyOrderName: order.name,
        shopifyLineItemId: String(line.id),
        sessionId: session.id,
        productId: session.productId,
        variantId: session.variantId,
        assetsSnapshot: session.assets,
        lineItemPropsSnapshot: props,
        status: "uploaded",
      },
    });

    // Mark session as converted
    await db.uploadSession.update({
      where: { id: session.id },
      data: { status: "converted" },
    });
  }

  // Process billing
  await processBillableOrder(shop.id, order);

  return new Response("OK", { status: 200 });
}
```

---

## 9. THEME APP EXTENSION — STOREFRONT

### 9.1 extensions/upload-block/blocks/upload.liquid

```liquid
<div
  id="printdock-upload-root"
  data-field-id="{{ block.settings.field_id }}"
  data-product-id="{{ product.id }}"
  data-variant-id="{{ product.selected_or_first_available_variant.id }}"
  data-app-url="{{ 'config' | app_url | remove: '/config' }}"
  data-required="{{ block.settings.required }}"
>
  <div class="printdock-loading">Loading field...</div>
</div>

<link rel="stylesheet" href="{{ 'upload.css' | asset_url }}">
<script src="{{ 'upload.js' | asset_url }}" defer></script>

{% schema %}
{
  "name": "PrintDock Upload",
  "target": "section",
  "settings": [
    {
      "type": "text",
      "id": "field_id",
      "label": "Field ID",
      "info": "Copy this from the PrintDock app → Fields"
    },
    {
      "type": "checkbox",
      "id": "required",
      "label": "Require upload before add to cart",
      "default": true
    }
  ]
}
{% endschema %}
```

### 9.2 extensions/upload-block/assets/upload.js

```javascript
(function () {
  "use strict";

  const root = document.getElementById("printdock-upload-root");
  if (!root) return;

  const APP_URL = root.dataset.appUrl;
  const PRODUCT_ID = root.dataset.productId;
  const FIELD_ID = root.dataset.fieldId;
  const IS_REQUIRED = root.dataset.required === "true";
  const SESSION_STORAGE_KEY = `printdock_session_${PRODUCT_ID}`;

  let sessionToken = null;
  let uploadedFiles = [];
  let isBlocked = false;

  // ─── INIT ────────────────────────────────────────────────────────────
  async function init() {
    renderUI();

    // Try to restore previous session (session recovery)
    const savedToken = localStorage.getItem(SESSION_STORAGE_KEY);
    if (savedToken) {
      const restored = await restoreSession(savedToken);
      if (!restored) {
        await startNewSession();
      }
    } else {
      await startNewSession();
    }

    setupAddToCartGuard();
  }

  // ─── SESSION MANAGEMENT ──────────────────────────────────────────────
  async function startNewSession() {
    try {
      const res = await fetch(`${APP_URL}/api/upload/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: window.Shopify?.shop || "",
          productId: PRODUCT_ID,
          variantId: root.dataset.variantId,
          fileName: "placeholder.png",
          mimeType: "image/png",
        }),
      });
      const data = await res.json();
      sessionToken = data.sessionToken;
      localStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
    } catch (err) {
      console.error("PrintDock: failed to start session", err);
    }
  }

  async function restoreSession(token) {
    try {
      const res = await fetch(`${APP_URL}/api/upload/restore?token=${token}`);
      if (!res.ok) return false;
      const data = await res.json();
      sessionToken = token;
      uploadedFiles = data.session.assets || [];
      renderFileList();
      return true;
    } catch {
      return false;
    }
  }

  // ─── FILE UPLOAD ──────────────────────────────────────────────────────
  async function handleFiles(files) {
    for (const file of files) {
      await uploadFile(file);
    }
  }

  async function uploadFile(file) {
    const fileEntry = {
      id: Math.random().toString(36).slice(2),
      name: file.name,
      size: file.size,
      status: "uploading",
      progress: 0,
      metadata: null,
      pricing: null,
      validationResults: [],
      blocked: false,
    };

    uploadedFiles.push(fileEntry);
    renderFileList();

    try {
      // Step 1: Get presigned URL from our server
      const sessionRes = await fetch(`${APP_URL}/api/upload/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: window.Shopify?.shop || "",
          productId: PRODUCT_ID,
          variantId: root.dataset.variantId,
          fileName: file.name,
          mimeType: file.type,
        }),
      });
      const sessionData = await sessionRes.json();
      sessionToken = sessionData.sessionToken;
      localStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
      const { presignedUrl, s3Key } = sessionData;

      // Step 2: Upload directly to S3 (app server is NOT involved)
      await uploadToS3(file, presignedUrl, (progress) => {
        fileEntry.progress = progress;
        renderFileList();
      });

      // Step 3: Confirm upload to our server for validation + pricing
      fileEntry.status = "validating";
      renderFileList();

      const confirmRes = await fetch(`${APP_URL}/api/upload/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken,
          s3Key,
          originalName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });
      const confirmData = await confirmRes.json();

      fileEntry.status = confirmData.blocked ? "blocked" : "success";
      fileEntry.metadata = confirmData.metadata;
      fileEntry.pricing = confirmData.pricing;
      fileEntry.validationResults = confirmData.validationResults;
      fileEntry.blocked = confirmData.blocked;
      fileEntry.assetId = confirmData.assetId;

    } catch (err) {
      fileEntry.status = "error";
      fileEntry.error = "Upload failed. Please try again.";
      console.error("PrintDock upload error:", err);
    }

    renderFileList();
    updateCartState();
    updatePriceDisplay();
  }

  async function uploadToS3(file, presignedUrl, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", presignedUrl, true);
      xhr.setRequestHeader("Content-Type", file.type);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error(`S3 upload failed: ${xhr.status}`));
      xhr.onerror = () => reject(new Error("S3 upload network error"));
      xhr.send(file);
    });
  }

  // ─── CART MANAGEMENT ─────────────────────────────────────────────────
  function setupAddToCartGuard() {
    const form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return;

    form.addEventListener("submit", (e) => {
      if (IS_REQUIRED && uploadedFiles.length === 0) {
        e.preventDefault();
        showError("Please upload your artwork before adding to cart.");
        return;
      }
      if (isBlocked) {
        e.preventDefault();
        showError("Please fix the file issues before adding to cart.");
        return;
      }
      injectCartProperties(form);
    });
  }

  function injectCartProperties(form) {
    if (!sessionToken) return;

    setHiddenInput(form, "properties[_uc_session]", sessionToken);

    const successFiles = uploadedFiles.filter((f) => f.status === "success");
    if (successFiles.length > 0) {
      const dims = successFiles
        .map((f) => {
          const m = f.metadata;
          if (m?.widthInch && m?.heightInch) {
            return `${m.widthInch.toFixed(1)}" × ${m.heightInch.toFixed(1)}"`;
          }
          return f.name;
        })
        .join(", ");

      setHiddenInput(form, "properties[Artwork size]", dims);
      setHiddenInput(form, "properties[Files uploaded]", successFiles.length.toString());
    }
  }

  function setHiddenInput(form, name, value) {
    let input = form.querySelector(`input[name="${CSS.escape(name)}"]`);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function updateCartState() {
    isBlocked = uploadedFiles.some((f) => f.blocked);
    const btn = document.querySelector('[name="add"], [id*="add-to-cart"], .product-form__submit');
    if (!btn) return;

    if (IS_REQUIRED && uploadedFiles.length === 0) {
      btn.disabled = true;
      btn.title = "Upload your artwork to continue";
    } else if (isBlocked) {
      btn.disabled = true;
      btn.title = "Please fix the file issues";
    } else {
      btn.disabled = false;
      btn.title = "";
    }
  }

  // ─── PRICE DISPLAY ────────────────────────────────────────────────────
  function updatePriceDisplay() {
    const successFiles = uploadedFiles.filter((f) => f.status === "success" && f.pricing);
    if (successFiles.length === 0) {
      const el = document.getElementById("printdock-price");
      if (el) el.remove();
      return;
    }

    const total = successFiles.reduce((sum, f) => sum + (f.pricing?.total ?? 0), 0);
    const explanation = successFiles[0]?.pricing?.explanation ?? "";

    let priceEl = document.getElementById("printdock-price");
    if (!priceEl) {
      priceEl = document.createElement("div");
      priceEl.id = "printdock-price";
      root.appendChild(priceEl);
    }

    priceEl.innerHTML = `
      <div class="printdock-price-display">
        <span class="printdock-price-label">Upload price:</span>
        <span class="printdock-price-amount">$${total.toFixed(2)}</span>
        <span class="printdock-price-explanation">${explanation}</span>
      </div>
    `;
  }

  // ─── RENDER ──────────────────────────────────────────────────────────
  function renderUI() {
    root.innerHTML = `
      <div class="printdock-upload">
        <div class="printdock-dropzone" id="printdock-dropzone">
          <input type="file" id="printdock-file-input" multiple accept=".png,.jpg,.jpeg,.pdf" hidden>
          <div class="printdock-drop-content">
            <div class="printdock-drop-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
            </div>
            <p class="printdock-drop-title">Drop your artwork here</p>
            <p class="printdock-drop-sub">PNG, PDF, JPG — up to 500MB</p>
            <button type="button" class="printdock-choose-btn" id="printdock-choose-btn">Choose file</button>
          </div>
        </div>
        <div class="printdock-file-list" id="printdock-file-list"></div>
        <div class="printdock-messages" id="printdock-messages"></div>
      </div>
    `;

    // Wire up events
    const dropzone = document.getElementById("printdock-dropzone");
    const fileInput = document.getElementById("printdock-file-input");
    const chooseBtn = document.getElementById("printdock-choose-btn");

    chooseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => handleFiles(Array.from(e.target.files)));

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("printdock-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("printdock-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("printdock-dragover");
      handleFiles(Array.from(e.dataTransfer.files));
    });
  }

  function renderFileList() {
    const list = document.getElementById("printdock-file-list");
    if (!list) return;

    if (uploadedFiles.length === 0) {
      list.innerHTML = "";
      return;
    }

    list.innerHTML = uploadedFiles.map((file) => `
      <div class="printdock-file-card printdock-file-${file.status}">
        <div class="printdock-file-info">
          <span class="printdock-file-name">${escapeHtml(file.name)}</span>
          <span class="printdock-file-size">${formatBytes(file.size)}</span>
        </div>
        ${file.status === "uploading" ? `
          <div class="printdock-progress-bar">
            <div class="printdock-progress-fill" style="width:${file.progress}%"></div>
          </div>
          <span class="printdock-status">${file.progress}%</span>
        ` : ""}
        ${file.status === "validating" ? `<span class="printdock-status">Checking file...</span>` : ""}
        ${file.status === "success" ? `
          <span class="printdock-status printdock-status-ok">
            ${file.metadata?.widthInch ? `${file.metadata.widthInch.toFixed(1)}" × ${file.metadata.heightInch.toFixed(1)}"` : ""}
            ${file.metadata?.dpi ? `· ${file.metadata.dpi} DPI` : ""}
          </span>
        ` : ""}
        ${file.validationResults?.filter(r => r.severity === "warning").map(r => `
          <div class="printdock-warning">${escapeHtml(r.message)}</div>
        `).join("") ?? ""}
        ${file.blocked ? `<div class="printdock-error">${file.validationResults.filter(r => r.severity === "blocking").map(r => r.message).join(", ")}</div>` : ""}
        ${file.status === "error" ? `<div class="printdock-error">${escapeHtml(file.error)}</div>` : ""}
        <button type="button" class="printdock-remove-btn" data-id="${file.id}">Remove</button>
      </div>
    `).join("");

    // Wire remove buttons
    list.querySelectorAll(".printdock-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => removeFile(btn.dataset.id));
    });
  }

  function removeFile(id) {
    uploadedFiles = uploadedFiles.filter((f) => f.id !== id);
    renderFileList();
    updateCartState();
    updatePriceDisplay();
  }

  function showError(msg) {
    const msgs = document.getElementById("printdock-messages");
    if (msgs) msgs.innerHTML = `<div class="printdock-error">${escapeHtml(msg)}</div>`;
    setTimeout(() => { if (msgs) msgs.innerHTML = ""; }, 4000);
  }

  // ─── UTILS ───────────────────────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── BOOTSTRAP ───────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
```

---

## 10. ADMIN UI PAGES — KEY SCREENS

### 10.1 Operations Center (app/routes/app.orders._index.tsx)

This is the most important admin page. It must have:
- **Filterable table**: status (all 6 statuses), date range, search by order name or customer email
- **Columns**: Order name, Customer, Product, # files, Total size, Status badge (color-coded), Date, Actions
- **Status badges**:
  - `uploaded` → blue
  - `validation_warning` → yellow
  - `pending_review` → orange
  - `approved` → green
  - `reupload_requested` → purple
  - `ready_for_production` → teal
- **Row actions**: Download files, View details, Change status
- **Bulk actions**: Bulk approve, Bulk ZIP download, Bulk mark ready
- Use Polaris `IndexTable`, `Filters`, `Badge`, `Button`

### 10.2 Job Detail Page (app/routes/app.orders.$id.tsx)

Must show:
- Order info card (order #, customer, product, date)
- File cards for each uploaded asset:
  - Filename, file size
  - Pixel dimensions (e.g. 3300 × 4200 px)
  - DPI value
  - Physical size in inches (e.g. 11.0" × 14.0")
  - Download button (signed S3 URL)
  - Validation results (green/yellow/red)
- Status selector (dropdown to change status)
- Internal notes section (chronological feed, add note form)
- Re-upload request button → generates token → sends email to customer
- ZIP download button (all files for this job)

### 10.3 Field config (app/routes/app.fields.$id.tsx)

Form sections:
1. **Basic settings**: Title (internal), Label (shown to customer), Help text, Required toggle, Max files, Max file size (MB)
2. **File types**: Checkboxes for PNG, JPEG, PDF (and custom allowlist)
3. **Pricing mode**: Radio buttons for None / Inch Height / Inch Square / Per File / Flat Rate. When mode selected: unit price input, minimum price input, live preview calculator
4. **Validation rules**: Dynamic list. Each rule: Type dropdown + Operator dropdown + Value input + Action (Prevent/Warn) + Message text. Add/remove rules.
5. **Product assignment**: Shopify ResourcePicker to select products. Show list of assigned products.

---

## 11. WEBHOOK HANDLERS

### HMAC Verification (app/utils/hmac.server.ts)

```typescript
import crypto from "crypto";

export function verifyWebhookHmac(
  rawBody: string,
  hmacHeader: string,
  secret: string
): boolean {
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(hmacHeader)
  );
}
```

### GDPR Webhooks (customers/data_request, customers/redact, shop/redact)

These 3 webhook handlers are REQUIRED by Shopify App Store review. They must:
- Verify HMAC signature
- For data_request: return 200 OK (we don't store PII beyond what's needed)
- For customers/redact: delete all UploadAssets from S3 + DB for that customer
- For shop/redact: delete all shop data (called 48h after uninstall)

---

## 12. SHOPIFY BILLING PLANS

| Plan | Monthly | % of upload sales | Cap |
|---|---|---|---|
| Starter | $19/mo | 0.75% | $200 |
| Growth | $49/mo | 0.50% | $500 |
| Pro | $99/mo | 0.30% | $1,000 |

**Key billing rules:**
- Only line items with `_uc_session` property qualify as "uploader-generated"
- Exclude: shipping, taxes, refunded lines, test orders
- Idempotency key: `shopId + shopifyOrderId + lineItemId`
- Usage charges submitted in batches, not per-event
- Merchant must see: current plan, accrued usage this cycle, estimated total

---

## 13. AWS S3 SETUP REQUIREMENTS

Tell the user to set up:

**Bucket config:**
- Name: `printdock-files` (or custom)
- Region: `eu-central-1` (Frankfurt — GDPR)
- Block all public access: **ON** (no public URLs ever)
- Versioning: optional

**CORS configuration (required for browser direct upload):**
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

**IAM Policy (attach to app's IAM user):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::printdock-files/*"
    }
  ]
}
```

---

## 14. NPM PACKAGES TO INSTALL

```bash
# Production dependencies
npm install \
  @shopify/shopify-app-remix \
  @shopify/polaris \
  @shopify/app-bridge-react \
  @prisma/client \
  @aws-sdk/client-s3 \
  @aws-sdk/s3-request-presigner \
  sharp \
  pdf-lib \
  archiver \
  resend \
  zod

# Dev dependencies
npm install -D \
  prisma \
  @shopify/cli \
  typescript \
  @types/archiver \
  @types/node
```

---

## 15. KEY RULES — DO NOT BREAK THESE

1. **Files NEVER pass through the app server.** Always use presigned URLs. The flow is: browser → presigned URL → S3 directly. The app server only gets a buffer for validation purposes AFTER upload completes.

2. **Always verify webhook HMAC signatures.** Every webhook handler must verify before processing.

3. **Tenant isolation.** Every DB query that touches data must include `shopId` in the WHERE clause. Never return data from one shop to another.

4. **Idempotency on webhooks.** `orders/create` can fire multiple times. Always check if an OrderJob already exists before creating.

5. **Session recovery.** The storefront JS saves `sessionToken` to `localStorage` keyed by productId. On page load, always try to restore the previous session first.

6. **Billing idempotency.** Never double-bill an order line. Use the composite key `shopId + orderId + lineItemId` to check for existing BillableOrderLine.

7. **GDPR webhooks are mandatory** for App Store review. All 3 must exist and return 200.

8. **S3 signed download URLs expire in 1 hour.** Never store or expose permanent S3 URLs. Always generate fresh signed URLs on each page load.

9. **Validation results are stored separately** from the asset. Never delete ValidationResults even if the asset is replaced (re-upload). Audit trail must be preserved.

10. **The operations center is the differentiator.** Upload Center (competitor) has zero post-order workflow. Every feature in the operations center (bulk ZIP, status management, internal notes, re-upload workflow) must work reliably.

---

## 16. DEPLOYMENT — Railway

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
```

Railway env variables to set (same as .env above but in Railway dashboard):
- All SHOPIFY_* vars
- DATABASE_URL (from Railway Postgres or Supabase)
- All AWS_* vars
- RESEND_API_KEY

---

## 17. WHAT SUCCESS LOOKS LIKE

**Shopper flow working:**
1. Shopper opens a product page → sees PrintDock upload zone
2. Drags a PNG onto the zone → progress bar → file analyzed
3. Sees "11.4" × 8.2" · 300 DPI — $5.70" immediately
4. Adds to cart → order placed → `_uc_session` appears in line item properties

**Merchant flow working:**
1. Merchant opens PrintDock → sees new order in Operations Center
2. Clicks order → sees file thumbnail, exact dimensions, validation status
3. Clicks "Download" → gets the original PNG from S3
4. Changes status to "Approved"
5. Optionally: clicks "Request re-upload" → customer gets email with link

**That's the MVP. Everything else is enhancement.**
