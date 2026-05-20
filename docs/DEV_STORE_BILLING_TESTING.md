# Dev store billing testing

PrintDock uses **Shopify App Pricing** (hosted plan selection). Development stores **cannot** approve paid public plans or subscriptions with usage charges. Use **$0 private test plans** to exercise the billing flow, or the **Firestore override script** for tier testing without a subscription round-trip.

See also: [APP_STORE_PRICING_AND_BILLING.md](./APP_STORE_PRICING_AND_BILLING.md) for production billing and plan-name mapping.

---

## 1. Partner Dashboard: $0 private test plans

**Path:** Partner Dashboard → Apps → PrintDock → Distribution → Manage submission → Pricing → **Private plans**

Create one private plan per tier you want to test:

| Setting | Value |
|---------|--------|
| Plan type | **Private** |
| Price | **$0** |
| Name | Exactly `Starter`, `Pro`, or `Business` (must match [`PLAN_SUBSCRIPTION_NAMES`](../app/config/plans.ts)) |
| Usage charges | **None** |
| Store allowlist | Your dev store domains (e.g. `levyapps.myshopify.com`, `printdock-test-store-1.myshopify.com`) |

Repeat for each tier. The allowlist is **mandatory** — without it, dev stores cannot see the plan in the picker.

Shopify docs: [Shopify App Pricing — test plan](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing#test-plan)

**Expected on dev stores:**

- $0 private plans → approve successfully
- Public paid plans → blocked ("No payment method" / charge-block errors — by design)

---

## 2. Subscribe on a dev store

1. Open PrintDock on the dev store → **Plans**
2. Click **Open plan selection in Shopify**
3. Pick the $0 private plan for the tier you want
4. Approve

The hosted page shows private plans alongside public ones. Only the allowlisted $0 private plans can be approved on a development store.

---

## 3. Verify billing wired through

After approval, confirm:

| Check | How |
|-------|-----|
| Webhook fired | Cloud Logging: `subscription_update_received`, `webhook_processed` with expected `subscriptionName` |
| Firestore | `shops/{shopDomain}/billing/plan` has `planCode` matching tier and `source: "shopify"` |
| Feature limits | Limits from [`plans.ts`](../app/config/plans.ts) unlock (file size, fields, dynamic pricing, storage cap) |
| Name mapping | If `planCode` stays `free`, inspect webhook payload `name` vs [`planCodeFromSubscriptionName`](../app/config/plans.ts). Watch for `subscription_name_unrecognized` in [OBSERVABILITY.md](./OBSERVABILITY.md) |
| Clean-down | Cancel test subscription → `planCode: "free"`, `source: "shopify"` |
| Tier change | Switch Pro → Starter on hosted page → `planCode: "starter"` |

**Override → subscribe → cancel** (regression for stale `dev_override`):

1. Run script with `--plan pro` (sets `source: "dev_override"`)
2. Subscribe to $0 Pro private plan (webhook must set `source: "shopify"`)
3. Cancel subscription → must return to `planCode: "free"`, not stay on Pro

---

## 4. Firestore escape hatch (feature testing)

For testing tier **limits and gates** without the billing UI, use:

```bash
node scripts/set-dev-billing-plan.mjs \
  --shop printdock-test-store-1.myshopify.com \
  --plan pro
```

Clear override:

```bash
node scripts/set-dev-billing-plan.mjs \
  --shop printdock-test-store-1.myshopify.com \
  --clear
```

### Safety

The script only writes to shops in a **hardcoded allowlist** inside the script (`printdock-test-store-1.myshopify.com`, `levyapps.myshopify.com`). Any other `--shop` is rejected before Firestore is touched.

On startup the script logs the Firebase **project ID** so cross-project runs are obvious.

To add a dev store: edit `ALLOWED_DEV_SHOPS` in [`scripts/set-dev-billing-plan.mjs`](../scripts/set-dev-billing-plan.mjs).

### `source` field

| `source` | Meaning |
|----------|---------|
| `dev_override` | Set by script; reconcile skips demotion when no Shopify subscription |
| `shopify` | Set by webhook/reconcile when synced from a real subscription |

When you later subscribe via Shopify, the webhook **always** sets `source: "shopify"`, clearing any override.

**When to use which path:**

- **$0 private plan** — test billing flow (plan page, webhooks, name mapping, upgrade/downgrade)
- **Script** — fast tier testing for feature work (limits, gates, UI)

---

## 5. Plans page dev-store banner

On development stores (`Shop.plan.partnerDevelopment === true`), the **Plans** page shows an info banner explaining private test plans. Production merchant stores do not see it.

---

## 6. Full verification matrix

| Test | Expected |
|------|----------|
| Subscribe to $0 private **Pro** | `planCode: "pro"`, `source: "shopify"`, Pro limits active |
| Try public paid **Pro** on dev store | Shopify blocks |
| Script `--plan business` (no Shopify sub) | Limits unlock; survives admin reload; `source: "dev_override"` |
| Script with non-allowlisted `--shop` | Exit 1, no write |
| Script startup | Firebase `projectId` logged |
| Cancel $0 private plan | `planCode: "free"`, `source: "shopify"` |
| Override → subscribe → cancel | Ends at `free` (no stale override) |
| Tier change Pro → Starter | `planCode: "starter"`, `source: "shopify"` |
| Banner on dev store | Visible |
| Banner on production store | Not rendered |
| Script `--clear` | `free`, `source` removed |

---

## Future radar

Private-plan store allowlists work for **your** dev stores but do not scale when Partners install PrintDock on their own dev stores to evaluate the app — each domain must be added manually in Partner Dashboard (and in the script allowlist for Firestore overrides). This is a known Shopify platform gap; revisit if partner dev installs become a channel.
