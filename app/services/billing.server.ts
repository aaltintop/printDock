/**
 * Shopify Billing helpers.
 *
 * PrintDock uses **Managed Pricing** (Partner Dashboard hosted plan selection).
 * There are no in-app Billing API subscription or usage-charge mutations today.
 * Plan changes happen on Shopify's pricing page
 * (`getManagedPricingPlanSelectionUrl` in `app/config/billing.ts`).
 *
 * Audited billing touchpoints (2026-05):
 * - `app/routes/app.plans.tsx` — redirects to Managed Pricing URL only
 * - `app/routes/webhooks.app_subscriptions.update.tsx` — syncs subscription state
 * - `app/routes/app.tsx` — reconciles activeSubscriptions from Admin API
 * - `app/shopify.server.ts` — no billing config on shopifyApp()
 *
 * Any future Billing API mutation MUST pass `test` / `isTest` from
 * {@link resolveBillingTestMode} — never hardcode boolean test flags.
 */
export { resolveBillingTestMode, type BillingTestModeDeps } from "./billing-test-mode.server";
