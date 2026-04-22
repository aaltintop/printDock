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

---

## Plan names must match (Firestore + feature limits)

PrintDock maps Shopify’s recurring subscription **display name** to an internal `planCode` (`starter` | `pro` | `business` | `free`) in [`app/config/plans.ts`](../app/config/plans.ts). This drives `shops/{shopDomain}/billing/plan` via:

- the **`APP_SUBSCRIPTIONS_UPDATE`** webhook ([`app/routes/webhooks.app_subscriptions.update.tsx`](../app/routes/webhooks.app_subscriptions.update.tsx)), and  
- a **reconciliation** step on each admin load ([`app/routes/app.tsx`](../app/routes/app.tsx)) using `currentAppInstallation.activeSubscriptions` as a safety net.

**Canonical names** (after normalization) must align with the keys in `PLAN_SUBSCRIPTION_NAMES`:

| `planCode` | Subscription name in Shopify (base) |
|------------|----------------------------------------|
| `starter`  | `Starter`                              |
| `pro`      | `Pro`                                  |
| `business` | `Business`                             |

**Normalization** (same for webhooks and Admin API):

- Case-insensitive match.
- Optional leading `PrintDock ` prefix is stripped (e.g. `PrintDock Pro` → `Pro`).
- Optional trailing frequency words are stripped: `Monthly`, `Yearly`, `Annual`, `Annually`, `Per month`, `Per year` (e.g. `Pro Monthly` → `Pro`).

If an **ACTIVE** (or **ACCEPTED**) subscription’s name does not map to a paid plan, the app stores `planCode: "free"` and logs **`subscription_name_unrecognized`** (check Cloud Logging / [`docs/OBSERVABILITY.md`](OBSERVABILITY.md)). Fix the plan title in the Partner Dashboard listing **Pricing** section to match the table above.

**Subscription statuses:** besides **ACTIVE** and **PENDING**, the webhook treats **CANCELLED**, **DECLINED**, **EXPIRED**, **FROZEN**, and **ON_HOLD** as ended and sets the shop to **free** / **inactive**. Unhandled statuses are logged as **`subscription_update_unhandled_status`** without changing Firestore.

---

## Plan limits (single source of truth: `plans.ts`)

All enforcement reads from [`app/config/plans.ts`](../app/config/plans.ts). Approximate caps:

| `planCode` | Max file (per upload) | Upload fields | File retention | Total upload storage (shop cap) |
|------------|------------------------|---------------|----------------|----------------------------------|
| `free`     | 50 MB                  | 2             | 7 days         | 500 MB                           |
| `starter`  | 300 MB                 | unlimited     | 7 days         | 15 GB                            |
| `pro`      | 1 GB                   | unlimited     | 30 days        | 30 GB                            |
| `business` | 5 GB                   | unlimited     | 30 days        | 75 GB                            |

**Orders:** there is **no** per-month order cap in the app; all plans can process orders without a monthly upload/order counter.

**Total storage:** the app sums **billable** bytes from upload session assets (skips expired / purged assets—see `getShopStorageUsageBytes` in [`app/services/shop-data.server.ts`](../app/services/shop-data.server.ts)). New uploads that would exceed `maxTotalStorageBytes` get **402** `storage_cap_exceeded` from [`app/routes/api.proxy.upload.session.tsx`](../app/routes/api.proxy.upload.session.tsx) and [`app/routes/api.proxy.upload.confirm.tsx`](../app/routes/api.proxy.upload.confirm.tsx).

**Feature flags** (`advancedValidation`, `fileRenaming`, `dynamicPricing`): see `PLANS` in code—Free locks advanced validation, renaming, and dynamic pricing; Starter unlocks validation + renaming; Pro/Business unlock dynamic pricing.

---

## Managed Pricing vs Billing API (PrintDock)

**Managed Pricing** (listing editor) defines what merchants subscribe to on Shopify. **PrintDock does not create subscriptions via the Billing API** in production; plan changes happen on Shopify’s hosted pricing page.

The older pattern of **usage line items** (`appSubscriptionCreate` + usage charges) is **not** used by this app today. If you add usage-based billing in the future, that would require a **manual** pricing app in Partners and new server-side charge logic—not Managed Pricing alone.

---

## Summary

- Use the Partner Dashboard listing **Pricing** section for **plan names and recurring charges**; keep names aligned with `PLAN_SUBSCRIPTION_NAMES`.
- Enforced limits (file size, fields, retention, total storage, features) live only in **`app/config/plans.ts`** and related routes—do not hardcode limits elsewhere.
