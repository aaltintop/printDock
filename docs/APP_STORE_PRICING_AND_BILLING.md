# App Store listing pricing and PrintDock billing

This document explains how **Shopify Managed Pricing** on your App Store listing relates to **in-app billing** for PrintDock, including usage-based charges.

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
