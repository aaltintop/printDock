# PrintDock developer glossary

**Audience:** developers working on this repository. Merchants use the in-app **Glossary** (`/app/glossary`), maintained in `app/data/merchant-glossary.ts` — do not copy developer-only terms there.

Plain-language definitions for terms used in code, Firestore, and internal docs. Each entry follows:

**Term** = one-sentence meaning in this project (not generic Shopify jargon).

For setup and day-to-day merchant operations, see [MERCHANT_GUIDE.md](./MERCHANT_GUIDE.md). For line-item property keys, see [MERCHANT_FIELDS.md](./MERCHANT_FIELDS.md).

---

## Core workflow (merchant-facing)

**Job (order job)** = one uploaded artwork tied to one order line, with status, file snapshot, and notes — what merchants manage on the **Order Jobs** page (`/app/orders`).

**Order Jobs page** = the in-app list of all jobs for the shop; each row is one job, not every order in Shopify Admin.

**Shopify order** = the merchant’s full order in Shopify Admin; a single order can have zero, one, or many PrintDock jobs (one per line item that checked out with an upload).

**Field (upload field)** = merchant configuration that defines which products/collections get an upload widget, file rules, dimension checks, and optional dynamic pricing.

**Upload session** = the customer’s in-progress upload on the product page before checkout, keyed by a session token; files live under temporary storage until the session converts or expires.

**Upload widget** = the storefront UI from the **PrintDock Upload** theme app block (`upload.js`); where customers pick files and see price/validation.

**Asset (upload asset)** = one file the customer uploaded, with metadata (size, dimensions, DPI, validation results, optional per-file price).

**Asset snapshot** = the copy of upload asset data stored on an order job after checkout so production files and metadata survive even if the session is cleaned up.

**Order ingest** = the server pipeline that runs after `orders/create`, copies artwork into order-scoped storage, renames the file, and completes the job’s `assetSnapshot`.

**Order ingest queue item** = a Firestore work item (`shops/{shop}/orderIngestQueue/{id}`) that schedules ingest for one line; processed by cron/internal workers with retries.

**Audit event (order job audit)** = one log line under a job (`jobs/{jobId}/audit/{eventId}`) recording what changed (status, notes, ingest finished, errors).

**Internal notes** = merchant-only text on a job, not shown to customers on the storefront.

**Assignee** = optional team member label on a job for internal workflow (not Shopify staff assignment).

**Job status** = merchant workflow state on a job: typically `uploaded`, `pending_review`, or `approved` (legacy `ready_for_production` maps to approved).

**Ingest status** = technical state of copying artwork onto the job: `pending`, `processing`, `complete`, or `failed`.

---

## Storefront & customer journey

**Theme app block (PrintDock Upload)** = the product-page block merchants add in the theme editor; required for customers to upload before add to cart.

**App proxy** = Shopify route prefix `/apps/printdock/...` on the storefront that forwards to PrintDock for uploads, signing, and short download links.

**Session token (`_uc_session`)** = stable ID linking a cart line, webhook, Cart Transform, and order job to the same upload session.

**Add to cart (PrintDock path)** = storefront adds **one** cart line with upload line properties and (when pricing is on) updates cart attribute `_pd_price_map`; not a separate hidden fee product in current (Build A) flow.

**Preflight** = quick client-side checks before upload starts; server confirm does full validation and pricing.

**Confirm upload** = app-proxy step after file hits storage that validates dimensions/rules and returns pricing for the widget.

**Converted session** = upload session marked `converted` after checkout so retention logic knows the file is tied to an order.

**Expired session** = session past `expiresAt` or cleaned up; uploads not converted to an order may be deleted after ~2 hours.

---

## Cart, checkout, and pricing

**Dynamic pricing** = upload fee calculated from file dimensions/rules (or flat rate), combined with the product’s base variant price at checkout via Cart Transform.

**Upload fee** = the PrintDock-calculated charge for the artwork (per unit), before adding the product base price for the signed total.

**Per-unit signed price (`p` in price token)** = HMAC-signed amount in minor units for **one** cart unit: variant base + upload fee(s) for that session; line total at checkout is this value × line quantity.

**Price token (`__ucToken` / JWT)** = signed proof of the per-unit price for a session; stored in cart `_pd_price_map` and optionally on the line for webhook audit.

**Price map (`_pd_price_map`)** = cart-level JSON attribute listing session IDs and their signed tokens; Cart Transform reads this as the source of truth for checkout pricing.

**Cart Transform (PrintDock / auto-pricing)** = Shopify Function that `lineExpand`s eligible lines to `fixedPricePerUnit` from the verified token in the price map (Build A: same variant, “Part of” presentation).

**Cart validation (cart-fee-validation)** = Shopify Function at checkout that blocks broken **legacy** two-line (Build B) carts (missing fee line, orphan fee line, qty mismatch); Build A single-line carts are largely unaffected.

**Build A (current default)** = one cart line per upload; combined price via Cart Transform on that line; Admin shows **Part of:** under the product line.

**Build B (legacy)** = older two-line cart (product line + separate fee line with `_pd_fee_for`); still supported at checkout by transform/validation for in-flight carts, not used for new storefront adds.

**Part of** = Shopify Admin/checkout label for the expanded component under a line when Cart Transform sets `lineExpand.title` (e.g. “Upload file”).

**HMAC secret (shop signing key)** = per-shop secret in Firestore used only to sign and verify price tokens; created during “Set up upload pricing” onboarding.

**Pricing evidence** = fields on a job recording whether a valid price token was present at order ingest (`hadPriceToken`, `tokenValid`, `anomalyReason`, etc.).

**Pricing anomaly** = flag when checkout/order data does not match a valid signed upload price (e.g. missing token, invalid signature); surfaced as a warning on the job.

---

## Downloads & links

**Print Ready File / View uploads** = customer- and merchant-facing download entry points; usually a short app-proxy URL (`/apps/printdock/f/{shortId}`) that resolves to a fresh signed storage URL on each click.

**Short link** = opaque ID stored at `shops/{shop}/downloadShortLinks/{shortId}` mapping to a storage path; keeps order line properties short and permanent.

**Signed download URL** = time-limited Google Cloud Storage URL generated on demand for merchants or proxy downloads; not stored permanently on the order.job

**Storage path** = GCS object key such as `uploads/{shop}/sessions/...` (pre-order) or `uploads/{shop}/orders/...` (post-ingest).

**Storage expired** = flag when retention deleted the blob but the job/order record remains for history.

---

## Shopify Functions & extensions (technical names)


| Handle / name           | Role                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `auto-pricing`          | Cart Transform function (Rust: `auto-pricing-rs`) for dynamic line pricing  |
| `cart-fee-validation`   | Cart validation function for legacy fee-line carts                          |
| `theme-extension`       | Theme app extension containing **PrintDock Upload** block and `upload.js`   |
| `printdock-order-files` | Admin order action extension for downloading files from Shopify order pages |


---

## Firestore data model (where things live)


| Path                                              | What it stores                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `shops/{shopDomain}`                              | Shop-level settings, billing hints, HMAC mirror, storage counters |
| `shops/{shopDomain}/fields/{fieldId}`             | Upload field configs                                              |
| `shops/{shopDomain}/sessions/{sessionToken}`      | Upload sessions (and nested `assets` when used)                   |
| `shops/{shopDomain}/jobs/{jobId}`                 | Order jobs                                                        |
| `shops/{shopDomain}/jobs/{jobId}/audit/{eventId}` | Audit events for that job                                         |
| `shops/{shopDomain}/orderIngestQueue/{ingestId}`  | Pending ingest work (`{orderId}_{lineItemId}`)                    |
| `shops/{shopDomain}/downloadShortLinks/{shortId}` | Short link → storage path                                         |
| `jobs` (legacy top-level)                         | Older order jobs with `shopDomain` field; merged when listing     |
| `sessions` (legacy top-level)                     | Older upload sessions; merged when listing                        |


**Shop domain** = store identifier string (e.g. `levyapps.myshopify.com`) scoping all PrintDock data for that merchant.

---

## Admin app pages


| Route                 | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `/app`                | Dashboard KPIs and setup checklist                                  |
| `/app/onboarding`     | Setup wizard (fields, theme block, cart validation, cart transform) |
| `/app/fields`         | Create/edit upload fields                                           |
| `/app/orders`         | Order Jobs list                                                     |
| `/app/orders/{jobId}` | Single job detail: download, status, notes, audit history           |
| `/app/plans`          | Billing plan                                                        |
| `/app/release-notes`  | Merchant-facing changelog                                           |


**Setup complete** = app considers onboarding done when: theme block verified, at least one field exists, cart validation satisfied, Cart Transform registered, and HMAC secret present.

---

## Webhooks & compliance

`**orders/create` webhook** = creates/updates jobs and enqueues order ingest when line items include `_uc_session`.

`**orders/fulfilled` webhook** = optional hook that can append audit events when orders fulfill.

**Compliance webhooks** = Shopify mandatory customer data export/redact handlers for app store policy.

---

## Plans & limits

**Plan code** = merchant subscription tier (`free`, `starter`, `pro`, `business`) gating features like dynamic pricing and storage caps. Dev store billing testing: [DEV_STORE_BILLING_TESTING.md](./DEV_STORE_BILLING_TESTING.md).

**Storage cap** = per-plan limit on total upload bytes tracked on the shop document; uploads blocked when exceeded.

**File storage days / retention** = plan-driven lifetime for blobs; order paths and active ingest paths are protected from orphan cleanup.

**Blocked upload** = session/file failed a blocking validation rule; customer cannot add to cart until fixed.

---

## Line item properties (quick reference)


| Key                               | Meaning                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `_uc_session`                     | Links line to upload session and job                                          |
| `__View uploads` / `View uploads` | Truncated or full print/download URL on the line                              |
| `Artwork`                         | File name(s); may live on line or only in price map depending on pricing mode |
| `__ucToken` / `__ucExp`           | Signed price token and expiry on line (parity / audit)                        |
| `_pd_fee_for`                     | Legacy Build B: fee line points to session id on product line                 |


Full matrix: [MERCHANT_FIELDS.md](./MERCHANT_FIELDS.md).

---

## Related docs

- [MERCHANT_GUIDE.md](./MERCHANT_GUIDE.md) — install, configure, operate
- [PRINT_READY_FILE_SHORT_LINKS.md](./PRINT_READY_FILE_SHORT_LINKS.md) — short links
- [APP_STORE_PRICING_AND_BILLING.md](./APP_STORE_PRICING_AND_BILLING.md) — production billing and plan mapping
- [DEV_STORE_BILLING_TESTING.md](./DEV_STORE_BILLING_TESTING.md) — dev store $0 private plans and override script
- [PrintDock_DynamicPricing_Plan.md](./PrintDock_DynamicPricing_Plan.md) — pricing architecture
- [STORAGE_RETENTION_AND_DELETION.md](./STORAGE_RETENTION_AND_DELETION.md) — retention rules
- [OBSERVABILITY.md](./OBSERVABILITY.md) — logs and events

