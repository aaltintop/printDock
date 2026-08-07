# App Store listing pricing and PrintDock billing

**PrintDock today:** Merchants choose plans via **Shopify Managed Pricing** only (the app opens Shopify’s hosted pricing page from **Plans**). The in-app `appSubscriptionCreate` checkout path has been removed. **There is no in-app usage line or percentage-of-sales billing**—subscriptions are the flat recurring charges defined in the Partner Dashboard.

This document explains how **Shopify Managed Pricing** on your App Store listing relates to **feature limits** enforced in code.

---

## Where Managed Pricing lives

Shopify Managed Pricing is configured **inside your App Store listing**, not only in code.

**Path in the Partner Dashboard:**

```
Partners Dashboard
  → Your app (printdock)
  → Distribution
  → Manage submission
  → Complete (next to "Complete your listing content")
  → This opens edit_listing/en
```

In the listing editor, open the **Pricing** section. There you define your plans: **name**, **price**, **trial days**, and **plan descriptions**. That configuration becomes the **pricing table** on your public App Store listing.

**Annual prices and savings** shown on the listing are **display-only** for merchants; the app does not store or compute yearly amounts in [`app/config/plans.ts`](../app/config/plans.ts). **Trial length** is whatever you set in the listing / Shopify Billing; the app does not implement trial countdown logic.

Keep listing bullets in sync with code — see [PARTNER_DASHBOARD_PLAN_CARDS.md](./PARTNER_DASHBOARD_PLAN_CARDS.md).

---

## Plan names must match (Firestore + feature limits)

PrintDock maps Shopify’s recurring subscription **display name** to an internal `planCode` (`free` | `starter` | `pro` | `business`) in [`app/config/plans.ts`](../app/config/plans.ts). This drives `shops/{shopDomain}/billing/plan` via:

- **Admin GraphQL reconcile** on each `/app` load ([`app/routes/app.tsx`](../app/routes/app.tsx)) using `currentAppInstallation.activeSubscriptions` — **primary synchronous source** for the billing gate.
- the **`APP_SUBSCRIPTIONS_UPDATE`** webhook ([`app/routes/webhooks.app_subscriptions.update.tsx`](../app/routes/webhooks.app_subscriptions.update.tsx)) — secondary push path (still observed firing as of 2026-08; see [BILLING_SPIKE_SOURCE_OF_TRUTH.md](./BILLING_SPIKE_SOURCE_OF_TRUTH.md)).
- a **scheduled billing reconcile cron** ([`app/routes/cron.billing-reconcile.tsx`](../app/routes/cron.billing-reconcile.tsx)) so cancellations are noticed without an admin visit.
- **`plan_handle`** on welcome-link return after plan approval.

**Canonical names** (after normalization) must align with the keys in `PLAN_SUBSCRIPTION_NAMES`:

| `planCode` | Subscription name in Shopify (base) |
|------------|----------------------------------------|
| `free`     | `Free`                                 |
| `starter`  | `Starter`                              |
| `pro`      | `Pro`                                  |
| `business` | `Business`                             |

**Normalization** (same for webhooks and Admin API):

- Case-insensitive match.
- Optional leading `PrintDock ` prefix is stripped (e.g. `PrintDock Pro` → `Pro`).
- Optional trailing frequency words are stripped: `Monthly`, `Yearly`, `Annual`, `Annually`, `Per month`, `Per year` (e.g. `Pro Monthly` → `Pro`).

If an **ACTIVE** (or **ACCEPTED**) subscription’s name does not map to a known plan, the app stores `planCode: "free"` and logs **`subscription_name_unrecognized`** (check Cloud Logging / [`docs/OBSERVABILITY.md`](OBSERVABILITY.md)). Fix the plan title in the Partner Dashboard listing **Pricing** section to match the table above.

**Subscription statuses:**

- **ACTIVE** / **ACCEPTED** → `status: "active"` with mapped `planCode` (including Free when the merchant selected the Free plan).
- **PENDING** → `status: "trial"`.
- **CANCELLED**, **DECLINED**, **EXPIRED** → `planCode: "free"`, `status: "inactive"` (no active contract).
- **FROZEN** / **ON_HOLD** → grace window then `inactive` if still unresolved (see billing gate docs).

Unhandled statuses are logged as **`subscription_update_unhandled_status`** without changing Firestore.

---

## Plan limits (single source of truth: `plans.ts`)

All enforcement reads from [`app/config/plans.ts`](../app/config/plans.ts). Caps:

| `planCode` | Max file (per upload) | Upload fields | File retention | Total upload storage (shop cap) |
|------------|------------------------|---------------|----------------|----------------------------------|
| `free`     | 50 MB                  | 2             | 7 days         | 500 MB                           |
| `starter`  | 100 MB                 | unlimited     | 30 days        | 15 GB                            |
| `pro`      | 300 MB                 | unlimited     | 30 days        | 30 GB                            |
| `business` | 5 GB                   | unlimited     | 30 days        | 75 GB                            |

**Orders:** there is **no** per-month order cap in the app; all plans can process orders without a monthly upload/order counter. Do **not** advertise “Unlimited orders” as a paid-only differentiator.

**Total storage:** the app maintains a running counter of **billable** bytes on the shop document (`shops/{shopDomain}.storageUsedBytes`) — see `getShopStorageUsageBytes` and `adjustShopStorageUsageBytes` in [`app/services/shop-data.server.ts`](../app/services/shop-data.server.ts). The counter is incremented on confirmed uploads and decremented on supersede/retention/orphan-sweep deletions. Legacy shops without the counter trigger a one-time recompute via `recomputeShopStorageUsageBytes`. New uploads that would exceed `maxTotalStorageBytes` get **402** `storage_cap_exceeded` from [`app/routes/api.proxy.upload.session.tsx`](../app/routes/api.proxy.upload.session.tsx) and [`app/routes/api.proxy.upload.confirm.tsx`](../app/routes/api.proxy.upload.confirm.tsx).

**Feature flags** (`advancedValidation`, `fileRenaming`, `dynamicPricing`): see `PLANS` in code.

| Feature | Free | Starter | Pro | Business |
|---------|------|---------|-----|----------|
| advancedValidation | No | No | Yes | Yes |
| fileRenaming | No | No | Yes | Yes |
| dynamicPricing | No | No | Yes | Yes |

**Processing ceiling:** confirm currently buffers the whole file and rejects above **500 MB** (`file_too_large_global`) regardless of plan. Business’s advertised 5 GB per-file limit is not fully deliverable until streaming/skip-metadata lands — see [PLAN_CONDITIONS.md](./PLAN_CONDITIONS.md).

---

## Managed Pricing vs Billing API (PrintDock)

**Managed Pricing** (listing editor) defines what merchants subscribe to on Shopify. **PrintDock does not create subscriptions via the Billing API** in production; plan changes happen on Shopify’s hosted pricing page.

The older pattern of **usage line items** (`appSubscriptionCreate` + usage charges) is **not** used by this app today. If you add usage-based billing in the future, that would require a **manual** pricing app in Partners and new server-side charge logic—not Managed Pricing alone.

---

## Mandatory plan selection

Every merchant must select a plan on Shopify’s hosted pricing page (**including Free**). Without an active Shopify subscription contract, the embedded admin redirects to `/app/plans` (locked state). Storefront proxy routes keep serving customers under Free limits and are **not** hard-blocked.

---

## Summary

- Use the Partner Dashboard listing **Pricing** section for **plan names and recurring charges**; keep names aligned with `PLAN_SUBSCRIPTION_NAMES`.
- Enforced limits (file size, fields, retention, total storage, features) live only in **`app/config/plans.ts`** and related routes—do not hardcode limits elsewhere.
- Admin reconcile + webhook + cron keep Firestore aligned; the billing gate fails open if verification throws.

---

## Dev store testing

Development stores **cannot** approve paid public plans. To test paid tiers without charging:

1. Create **$0 private test plans** in the Partner Dashboard (one per tier: Starter, Pro, Business).
2. **Allowlist** each dev store domain on those plans.
3. Subscribe via PrintDock → **Plans** → hosted plan selection.

For feature testing without the billing UI, use `scripts/set-dev-billing-plan.mjs` (allowlisted dev shops only).

Full workflow, verification matrix, and safety guards: **[DEV_STORE_BILLING_TESTING.md](./DEV_STORE_BILLING_TESTING.md)**.
