# App Store listing pricing and PrintDock billing

**PrintDock today:** Merchants choose plans via **Shopify Managed Pricing** only (the app opens Shopify’s hosted pricing page from **Plans**). The in-app `appSubscriptionCreate` checkout path has been removed. Order-side usage recognition in code (`processBillableOrder`) still runs against the shop’s active subscription when applicable.

This document explains how **Shopify Managed Pricing** on your App Store listing relates to billing concepts for PrintDock, including usage-based charges.

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

In the listing editor, open the **Pricing** section. There you define your plans: **name**, **price**, **trial days**, and **plan descriptions**. That configuration becomes the **pricing table** on your public App Store listing (similar to other apps that show tiers such as Basic $9/mo, Basic+ $19/mo, etc.).

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

If an **ACTIVE** (or **ACCEPTED**) subscription’s name does not map to a paid plan, the app stores `planCode: "free"` and logs **`subscription_name_unrecognized`** (check Cloud Logging / `docs/OBSERVABILITY.md`). Fix the plan title in the Partner Dashboard listing **Pricing** section to match the table above.

**Subscription statuses:** besides **ACTIVE** and **PENDING**, the webhook treats **CANCELLED**, **DECLINED**, **EXPIRED**, **FROZEN**, and **ON_HOLD** as ended and sets the shop to **free** / **inactive**. Unhandled statuses are logged as **`subscription_update_unhandled_status`** without changing Firestore.

---

## Managed Pricing vs Billing API (critical for PrintDock)

**Managed Pricing in the listing editor only supports flat recurring plans.** It does **not** support a **usage** component (for example, a percentage of uploader-driven sales).

For usage-based billing you must use the **Billing API** in your app code—for example `appSubscriptionCreate` with a **usage** line item alongside the recurring charge.

---

## How this applies to PrintDock

| Surface | Role |
|--------|------|
| **Listing editor — Pricing** | Defines the **plan names and base prices** merchants see on the App Store. Supports **display and discovery**. |
| **Billing API in the app** | **Creates the actual subscription** when a merchant installs or selects a plan, including both the **base fee** and any **usage** component (e.g. percentage of uploader sales). |

**Both are needed:** the listing aligns what merchants expect when they discover the app; the code implements the real subscription and usage charges.

---

## Summary

- Use the Partner Dashboard listing **Pricing** section for **recurring plan presentation** on the App Store.
- Implement **usage** (and the exact charge structure) with the **Billing API** in code—Managed Pricing in the listing cannot replace that for usage-based revenue.
