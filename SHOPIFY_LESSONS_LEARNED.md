# Shopify App — Lessons Learned Playbook

Distilled, hard-won experience from building **PrintDock** (a production public Shopify app). This is the "what I wish I knew on day one" companion to the full `SHOPIFY_APP_BLUEPRINT.md`. Copy this into any new Shopify project and read it before you write your first route.

> If the blueprint is the *manual*, this is the *scar tissue*. Everything here cost real debugging time at least once.

---

## Table of contents

1. [The stack that actually worked](#1-the-stack-that-actually-worked)
2. [Decisions to lock in before writing code](#2-decisions-to-lock-in-before-writing-code)
3. [Auth & the embedded iframe](#3-auth--the-embedded-iframe)
4. [Webhooks: the #1 source of pain](#4-webhooks-the-1-source-of-pain)
5. [Database & storage (Firestore + GCS)](#5-database--storage-firestore--gcs)
6. [Billing: use Managed Pricing](#6-billing-use-managed-pricing)
7. [Shopify Functions (Cart Transform etc.)](#7-shopify-functions-cart-transform-etc)
8. [Storefront: theme extension + app proxy](#8-storefront-theme-extension--app-proxy)
9. [Deployment & infrastructure](#9-deployment--infrastructure)
10. [Observability, errors & logging](#10-observability-errors--logging)
11. [Testing & release discipline](#11-testing--release-discipline)
12. [App Store review gotchas](#12-app-store-review-gotchas)
13. [Working conventions that paid off](#13-working-conventions-that-paid-off)
14. [Copy-paste starter checklist](#14-copy-paste-starter-checklist)

---

## 1. The stack that actually worked

| Layer | Choice | Why it earned its place |
|---|---|---|
| Admin framework | **React Router 7 (SSR)** — *not* Remix, *not* Next | Official Shopify template direction now. Same loader/action mental model as Remix, no lock-in surprises. |
| UI | **Polaris + App Bridge React** | Native admin look, a11y for free, embedded modal/toast/nav primitives. Don't fight it with a custom CSS framework. |
| Shopify SDK | `@shopify/shopify-app-react-router` + `@shopify/shopify-api` | Handles OAuth, session, webhook HMAC verification, GraphQL client. |
| DB | **Firestore** (`firebase-admin`) — *not* Prisma/Postgres | Serverless, scales to zero, native ADC on Cloud Run, zero migration overhead. |
| Files | **Firebase Storage (GCS)** with v4 signed URLs | Direct browser-to-bucket uploads, no proxying big files through the app. |
| Sessions | Custom `FirestoreSessionStorage` adapter | Same DB as app data, multi-instance safe. |
| Hosting | **Google Cloud Run** (Docker multi-stage) | Scales to zero, ADC = no key files when in the same GCP project. |
| Cron | **Cloud Scheduler → HTTP route** | Simplest possible background jobs; no extra infra. |
| Billing | **Shopify Managed Pricing** | No Billing API mutations, fewer review risks. |
| Functions | **Rust → WASM** Shopify Functions | Production-grade; keep a TS reference twin if helpful but ship Rust. |
| Validation | `zod` | Type-safe boundary parsing on every proxy/webhook/action. |

**What we deliberately did NOT use** (and were glad): Prisma, PostgreSQL, Redis, Next.js, Remix v2, third-party analytics SDKs, custom CSS.

> ⚠️ **Watch the template cruft.** The upstream Shopify template ships README text about Prisma/SQLite session storage and Windows/ARM MongoDB gotchas. None of it applies once you move to Firestore. Delete stale template docs early so they don't mislead contributors (this bit us — new readers trusted the README's Prisma advice that was never true for the app).

---

## 2. Decisions to lock in before writing code

These are the choices that are painful to reverse later. Nail them in a `PROJECT_SPEC.md` first.

1. **Protected Customer Data (PCD) tier.** This dominates App Store review timeline more than feature completeness. Stay at **Level 1** unless the product genuinely needs Level 2 customer PII. Decide before you design storage.
2. **Validate your infra against the spec, not the template.** PrintDock's original spec said Remix + Prisma + Postgres + S3 + Railway. The shipped app is React Router + Firestore + GCS + Cloud Run. The migration was avoidable rework — pick the real stack up front.
3. **One Cart Transform per shop.** If you use Cart Transform Functions, you cannot have two. Detect conflicts in onboarding.
4. **Managed Pricing vs Billing API.** Decide now; they lead to completely different plan/webhook code.
5. **Data retention policy.** Firestore is schemaless, so retention is *your* job. Decide TTLs (uploads, sessions, jobs) and put them in config, not scattered constants.
6. **API version split.** The webhook delivery version in `shopify.app.toml` and the Admin API client version in `shopify.server.ts` can legitimately differ. Document which is which so it doesn't look like a bug.

---

## 3. Auth & the embedded iframe

The app runs in an iframe under `admin.shopify.com`. Cross-origin rules are non-negotiable and cause the weirdest bugs.

**The redirect-that-kills-auth bug (cost hours).** When you redirect inside the embedded app (e.g. to an onboarding page), you *must* preserve the embedded query string (`embedded`, `host`, `shop`, `id_token`, `hmac`, ...). Strip it and the next request authenticates with no shop hint, `authenticate.admin()` bounces to `/auth/login`, and the merchant sees a public "enter your shop domain" form **inside the admin iframe**. Looks like a total auth failure; it's just a lost query string.

```ts
// GOOD: keep the embedded query string on internal redirects
const onboardingUrl = new URL(`/app/onboarding${currentUrl.search}`, currentUrl.origin);
```

Other embedded rules that matter:

- Use React Router `Link`, **not** `<a>`, for in-app navigation.
- Use the `redirect` returned from `authenticate.admin`, **not** React Router's generic `redirect`, for auth-aware redirects.
- Use App Bridge primitives (`<ui-modal>`, `<ui-toast>`, `<ui-title-bar>`, `<ui-nav-menu>`, `useAppBridge()`) instead of custom frame/window hacks. Don't touch the parent frame DOM.
- Turn on offline-token auto-refresh: `future: { expiringOfflineAccessTokens: true }`.
- Three distinct auth contexts, don't mix them up:
  - `authenticate.admin(request)` — embedded admin pages
  - `authenticate.webhook(request)` — webhook routes
  - `authenticate.public.appProxy(request)` — storefront/app-proxy routes

---

## 4. Webhooks: the #1 source of pain

More time lost here than anywhere else. Rules that prevent it:

- **Declare subscriptions in `shopify.app.toml`, not in `afterAuth`.** App-specific subscriptions sync on `shopify app deploy`. Registering in `afterAuth` doesn't reliably update during normal dev and leads to "why isn't my webhook firing" confusion.
- **Acknowledge fast (< 5s), offload heavy work.** Shopify's timeout is strict and it *retries*. The winning pattern: webhook writes a placeholder record + enqueues a work item, then a **cron/queue** does the heavy lifting.
- **Be idempotent.** Retries happen. Key work by a natural/event id (e.g. `{orderId}_{lineItemId}`) so a replay is a no-op.
- **Never let one bad payload crash the process.** Isolate per-item work with defensive guards.
- **Let the SDK's Response throw propagate.** A helper like `rethrowIfShopifyWebhookResponse(caught)` that re-throws when `caught instanceof Response` keeps the SDK's 401/405 semantics intact instead of swallowing them into a 500.
- **Expect quirks in dev:** admin-created test webhooks fail HMAC validation; CLI-triggered webhooks arrive with `admin` undefined. Both are expected, not bugs.

**Always-required webhooks** (App Store will reject you without them):

| Topic | Purpose |
|---|---|
| `app/uninstalled` | Purge shop data (Firestore + Storage) + clear secrets |
| `app/scopes_update` | Update stored scopes (any scope change fails review without this) |
| `app_subscriptions/update` | Sync Managed Pricing plan → your DB |
| `customers/data_request` | GDPR export |
| `customers/redact` | GDPR delete customer data |
| `shop/redact` | GDPR full shop purge |

Handle **all** subscription states in `app_subscriptions/update`: `ACTIVE`, `ACCEPTED`, `PENDING`, `CANCELLED`, `DECLINED`, `EXPIRED`, `FROZEN`, `ON_HOLD`.

---

## 5. Database & storage (Firestore + GCS)

**Firestore rejects `undefined`.** This throws at write time, not build time, so it hides until runtime. Run every object through a `stripUndefinedDeep()` helper before writing. Non-negotiable.

Other lessons:

- **Schemaless ≠ no schema.** Keep TypeScript domain types (`app/types/*.ts`) as the contract and normalize on read (map legacy shapes, migrate old enum/plan codes) rather than doing big-bang migrations.
- **Merge legacy collections at read time** if you restructure (e.g. top-level `jobs` → `shops/{shop}/jobs`). Write a one-shot migration script but tolerate old data on read.
- **Model as a shop-scoped hierarchy:** `shops/{shopDomain}/...` for everything shop-specific keeps queries and deletion (uninstall/redact) simple.
- **Soft-delete + hard-delete TTL** for user-editable config so an accidental delete is recoverable.

**Storage / signed URLs:**

- Use **v4 signed URLs** for direct browser→bucket uploads. Don't stream large files through your app server.
- **The signBlob IAM gotcha (cost real time):** Cloud Run's ADC can't sign URLs without the runtime service account having `roles/iam.serviceAccountTokenCreator`. Symptom: `SigningError: Permission 'iam.serviceAccounts.signBlob' denied`. Grant it during infra bootstrap.
- **Short permanent links.** Order line-item properties get auto-linkified in the admin only if short. Store a `shortId` → 302-redirect to a freshly-signed URL, instead of stuffing a giant signed URL into the property.
- **Orphan sweep.** Uploads that never convert to an order leak storage. A cron with a short TTL (e.g. 2h) cleans unconverted sessions.

---

## 6. Billing: use Managed Pricing

- **Managed Pricing** (plans defined in Partner Dashboard, merchant picks in Shopify-hosted UI) is simpler and lower review-risk than the Billing API. PrintDock ships zero `appSubscriptionCreate` mutations.
- **Plan names must match exactly.** In-app plan codes in `config/plans.ts` must map to the exact Partner Dashboard plan names (after frequency-suffix normalization). Mismatches cause silent billing confusion.
- **Keep the free tier genuinely useful.** App Store requires free-or-trial, and an "empty free plan" increases churn and review friction.
- **Prefer usage/size caps over feature-matrix complexity** — merchants understand "500 MB / 50 orders" faster than a grid of toggles.
- **Dev stores can't approve paid plans.** For tier testing, use $0 private plans with a store allowlist, and/or a Firestore override script to force a tier locally.
- **Guard against regressions:** a unit test that fails if any Billing API mutation string appears keeps you honest that you're still Managed-Pricing-only.

---

## 7. Shopify Functions (Cart Transform etc.)

- **Functions have no clock and no I/O.** They're deterministic WASM. You **cannot** check token expiry or call an API inside them. Enforce time-based rules server-side (e.g. at the order webhook), not in the function.
- **Ship Rust, not TypeScript, for production functions.** PrintDock keeps a TS twin as reference but it's disabled; the Rust build is what runs.
- **One Cart Transform per shop** — plan for the conflict.
- **Sign your data.** PrintDock passes an HMAC-SHA256 signed, JWT-like price token through a cart attribute; the function verifies it against a per-shop secret stored in a shop metafield. The Node side (`price-token.server.ts`) and the Rust side must agree on the exact token format — this coupling is the thing most likely to break, so test both sides against shared fixtures.
- Use `timingSafeEqual` for signature comparison.
- Provision the per-shop signing secret during onboarding (store it in an app-owned metafield and/or Firestore), and clear it on uninstall.

---

## 8. Storefront: theme extension + app proxy

- **App proxy is the storefront→app bridge.** `https://{shop}/apps/{subpath}/...` forwards to your server with HMAC. Validate with `authenticate.public.appProxy(request)` and parse the body with `zod`.
- **Return proper JSON.** When `Accept: application/json` is sent, an app-proxy route must return JSON (a common automated-review failure is returning HTML).
- **Stable public error contract.** Give storefront endpoints a fixed `{ error, message, reference? }` shape: a machine code, a shopper-safe message, and a short reference id on 5xx for support correlation. Don't leak internals.
- **Theme JS goes monolithic fast.** PrintDock's `upload.js` grew past 3000 lines. Add a pre-deploy syntax gate (`node --check ...`) as a `predeploy` script so a typo can't ship.
- **Liquid stamps once.** Variant price rendered in Liquid is fixed at render time — re-read it on the client when the variant switches, or you'll show stale prices.
- **Degrade gracefully.** Theme blocks must not crash when product/cart context is missing.
- **Multi-template stores need explicit placement guidance.** Onboarding should *detect* whether the block is actually installed/active per template, not just link to docs.

---

## 9. Deployment & infrastructure

**Deploy order matters (two phases, specific sequence):**

1. Deploy the backend to Cloud Run (`gcloud run deploy`).
2. Update the URLs in `shopify.app.toml`.
3. Run `shopify app deploy` to push extensions + webhook/proxy config.

Doing `shopify app deploy` first points Shopify at a URL that isn't live yet.

Other infra lessons:

- **Same GCP project as Firebase ⇒ no service-account JSON.** ADC just works on Cloud Run. Only wire a key file for local dev or cross-project setups.
- **`min-instances=1` in production.** Cold starts make embedded admin feel broken and can blow webhook timeouts. Only set `0` if cost is explicitly prioritized over responsiveness.
- **Keep `SCOPES` in `.env` and `shopify.app.toml` in sync.** Drift causes scope-grant loops.
- **Cache your Docker builds** (Kaniko + Artifact Registry layer cache in `cloudbuild.yaml`) or CI builds get slow.
- **Inject build metadata** (build id, deployed-at, version) as Docker build args and surface it on an internal "release notes"/version page — invaluable for "is my deploy actually live?".
- **Cron auth:** protect `/cron/*` HTTP routes with a bearer secret (`Authorization: Bearer <secret>` or an `X-Cron-Secret` header). Never leave them open.

---

## 10. Observability, errors & logging

- **Structured JSON logs from day one.** One JSON object per line → Cloud Logging filters by `jsonPayload.event`. Retrofitting logging after an incident is misery.
- **Request-scoped context via AsyncLocalStorage.** Wrap every loader/action/webhook in a `runWithRequestContext` that attaches `requestId`, `route`, `method`, `shopDomain`. Then a single request id ties together every log line — including async work.
- **Scrub secrets in the logger itself** (accessToken, signedUrl, etc.), so no call site can accidentally log them.
- **Define an event vocabulary** and document it, so logs are queryable rather than free-text.
- **Set up error tracking + uptime + alerts before launch:** Sentry (or equivalent) for server+client, an uptime check on the app URL, and an alert policy for webhook 5xx spikes and latency.
- **Write the top-3 incident runbooks early** (auth failure, webhook failures, billing mismatch). "We'll write runbooks later" means never.

---

## 11. Testing & release discipline

- **Unit-test the pure domain logic** (services, validation schemas, plan-limit checks, token signing/verification, dimension/DPI math). This is where bugs are cheap to catch.
- **Integration-test webhooks** with valid HMAC + invalid HMAC + idempotent replay + failure path.
- **Test both sides of the Function boundary** against shared fixtures (Node signs, Rust verifies).
- **Keep a repeatable dev-store smoke script:** install → onboard → trigger required webhooks → verify plan flow → uninstall cleanup.
- **Gap to avoid:** PrintDock had no CI pipeline — only a manual pre-release checklist (`typecheck && lint && build && test`). Wire that same command into GitHub Actions on day one so it's actually enforced.
- **Also missing and worth adding early:** explicit retry/backoff around GraphQL 429 (throttle) responses. The SDK defaults are fine at low volume but not for busy shops.

---

## 12. App Store review gotchas

Common automated-review failures to design out from the start:

- Calling the Admin API with an offline token **before** installation completes.
- Missing the `app/scopes_update` handler (any scope change then fails review).
- Hardcoded `apiKey`/`apiSecretKey` instead of env vars.
- App-proxy routes returning non-JSON when JSON was requested.
- Unhandled throws in webhooks (must return 500 gracefully, not crash).
- Theme app extension not localized (`locales/en.default.json` missing keys).
- GDPR webhooks not responding 200 to test pings.
- Uninstall not demonstrably purging data (reviewers test this hard).

---

## 13. Working conventions that paid off

- **Thin routes, fat services.** Routes authenticate → validate → call a service → return. All Firestore/GraphQL/storage logic lives in `app/services/*.server.ts`.
- **`.server.ts` suffix** for server-only modules — makes the client/server boundary obvious and keeps secrets out of the client bundle.
- **Declarative config over magic numbers.** Plan limits, retention windows, storage lifecycle → dedicated `app/config/*` files.
- **Extensions as isolated npm workspaces** (`extensions/*`), each with its own `shopify.extension.toml` and (for Rust functions) its own Cargo build.
- **`unauthenticated.admin(shop)`** for background jobs (cron/queue) that have no request context.
- **Document as you go.** PrintDock's biggest asset is its docs (glossary, deploy guide, blueprint, data-protection questionnaire answers). Future-you and reviewers both benefit.

---

## 14. Copy-paste starter checklist

Day-one setup for a new app on this stack:

- [ ] `shopify app init` with the React Router 7 template; delete stale Prisma/template README sections.
- [ ] Wire `shopifyApp({...})` with `sessionStorage: new FirestoreSessionStorage()`, `apiVersion: ApiVersion.<current>`, `future: { expiringOfflineAccessTokens: true }`, `distribution: AppDistribution.AppStore`.
- [ ] Firebase Admin init + `FirestoreSessionStorage` adapter + `stripUndefinedDeep()` helper.
- [ ] `.gitignore`: `.env`, `*-credentials.json`, `BOOTSTRAP_INPUTS.local.md`, `.cloudrun.env`.
- [ ] GCP: service account with `roles/datastore.user` + `roles/storage.objectAdmin` + **`roles/iam.serviceAccountTokenCreator`** (the signBlob one).
- [ ] `shopify.app.toml`: scopes, app proxy, and **all** required webhook subscriptions (uninstalled, scopes_update, app_subscriptions/update, 3× GDPR).
- [ ] Webhook handlers: fast-ack + enqueue pattern, idempotent, `runWithRequestContext`, `rethrowIfShopifyWebhookResponse`.
- [ ] Structured JSON logger with request context + secret scrubbing.
- [ ] `config/plans.ts` with tiers matching Partner Dashboard Managed Pricing names exactly; keep a real free tier.
- [ ] Public API error contract (`{ error, message, reference? }`) for proxy routes.
- [ ] Onboarding page exempt from the onboarding-redirect; detects real setup state (block installed, plan chosen, scopes granted, function active).
- [ ] Cloud Run: multi-stage Docker, `min-instances=1`, build metadata as build args.
- [ ] Deploy order wired into a script: Cloud Run → update toml URLs → `shopify app deploy`.
- [ ] Cron routes protected by bearer secret; Cloud Scheduler configured.
- [ ] CI: `typecheck && lint && build && test` on every PR.
- [ ] Dev-store smoke script committed.
- [ ] PCD tier decided and documented; GDPR + uninstall purge verified end-to-end.

---

*Companion to `SHOPIFY_APP_BLUEPRINT.md` (the full reference & bootstrap protocol). This file is the concentrated experience; the blueprint is the step-by-step build guide.*
