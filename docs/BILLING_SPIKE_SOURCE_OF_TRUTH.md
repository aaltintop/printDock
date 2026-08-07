# Spike: subscription source of truth (Phase 0)

**Date:** 2026-08-07  
**Store:** `levyapps.myshopify.com` (dev store with $0 private / App Pricing plans)  
**Project:** `printdock-976d5`

## Questions

1. Does `APP_SUBSCRIPTIONS_UPDATE` still fire for Shopify App Pricing?
2. Does Admin GraphQL `currentAppInstallation.activeSubscriptions` still return App Pricing contracts?

## Evidence (Cloud Logging)

| Timestamp (UTC) | Event | Notes |
|-----------------|-------|--------|
| 2026-08-07T14:46:47Z | `subscription_update_received` | Webhook still delivered |
| 2026-08-07T14:44:09Z | `billing_plan_reconciled` | Admin-load reconcile ran |
| 2026-08-07T15:45:36Z / 15:45:39Z | `plans_page_view` | Merchant opened Plans; hosted UI showed Pro as **Current** |

Older samples (2026-07-30) also show both `subscription_update_received` and `billing_plan_reconciled` for other shops.

## Conclusion → **Phase 2 hybrid (2a + keep webhook)**

Shopify docs say App Pricing stopped subscription webhooks after 2026-04-28 and steer apps toward the Partner API. **Empirically, both legs still work for PrintDock today:**

- **Admin GraphQL `activeSubscriptions`** — confirmed via reconcile events and the hosted pricing “Current” badge matching in-app state.
- **`app_subscriptions/update` webhook** — still delivered as of 2026-08-07.

### Implementation choice

1. Treat **Admin GraphQL reconcile on `/app` load** as the **synchronous source of truth for the billing gate** (must not wait for webhooks).
2. **Keep the webhook** as a secondary push path while it continues to fire; update it to write `inactive` correctly (same as reconcile).
3. Add a **scheduled billing reconcile cron** so cancellations are noticed without an admin visit.
4. Handle **`plan_handle`** on welcome-link return for immediate re-verify.
5. **Do not migrate to Partner API yet** — revisit when webhook delivery stops or Admin `activeSubscriptions` goes empty for App Pricing contracts.

## Follow-up radar

- If Cloud Logging shows zero `subscription_update_received` for >30 days while plan changes still happen, retire the webhook subscription from `shopify.app.toml`.
- If Admin reconcile starts writing `inactive` for shops that still show a Current plan on the hosted page, implement Partner API `activeSubscription` (plan Phase 2b).
