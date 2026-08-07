# Partner Dashboard plan card checklist

Manual edits in the Shopify Partner Dashboard so hosted plan cards match [`app/config/plans.ts`](../app/config/plans.ts) and merchant expectations.

**Path:** Partners → PrintDock → Distribution → Manage listing → Pricing

## Required edits

### 1. Remove “Unlimited orders”

Remove the **Unlimited orders** bullet from **Starter**, **Pro**, and **Business**.

There is **no** per-month order cap on any plan (including Free). The bullet is a phantom differentiator and implies Free is order-capped.

### 2. Add total storage caps (enforced, previously undisclosed)

Add a storage line to each card:

| Plan | Add bullet |
|------|------------|
| Free | Total storage 500 MB |
| Starter | Total storage 15 GB |
| Pro | Total storage 30 GB |
| Business | Total storage 75 GB |

Exceeding the cap returns **402** `storage_cap_exceeded` from the storefront upload API. Merchants must see the limit before subscribe.

### 3. Keep feature bullets aligned with code

Confirm each card matches:

| Plan | Max file | Fields | Retention | Features |
|------|----------|--------|-----------|----------|
| Free | 50 MB | 2 | 7 days | Basic validation only |
| Starter | 100 MB | Unlimited | 30 days | (no advanced validation / renaming / dynamic pricing) |
| Pro | 300 MB | Unlimited | 30 days | Advanced validation, file renaming, dynamic pricing |
| Business | 5 GB | Unlimited | 30 days | Same as Pro |

### 4. Business 5 GB caveat (until follow-up)

Plan tier advertises **5 GB** per file, but confirm currently buffers the whole object and hard-fails above **500 MB** (`file_too_large_global`). See [PLAN_CONDITIONS.md](./PLAN_CONDITIONS.md) § Processing ceiling. Until streaming/skip-metadata ships, either:

- leave the 5 GB marketing claim and accept support risk, or  
- temporarily list **500 MB** on Business in the dashboard to match the processing ceiling.

## Welcome link

Configure each plan’s welcome / redirection URL to the embedded app root (e.g. `/app`) so Shopify appends `plan_handle` after approval. PrintDock re-verifies subscription on that return.

## After editing

1. Open hosted plan selection on a dev store and screenshot the four cards.
2. Diff against this checklist and `docs/PLAN_CONDITIONS.md`.
3. Subscribe / cancel a $0 private plan and confirm Firestore + gate behave (see [DEV_STORE_BILLING_TESTING.md](./DEV_STORE_BILLING_TESTING.md)).
