/**
 * Managed app pricing (Partner Dashboard) uses Shopify-hosted plan selection and
 * forbids creating charges via the Billing API. Manual pricing uses appSubscriptionCreate.
 *
 * @see https://shopify.dev/docs/apps/launch/billing/managed-pricing
 */
export type BillingMode = "managed" | "api";

/** Billing integration when `SHOPIFY_BILLING_MODE` is unset, empty, or any value other than exact `api`. */
export const DEFAULT_BILLING_MODE: BillingMode = "managed";

/**
 * - Default (no env, empty, unknown, or `managed`): **Shopify-hosted** plan selection
 *   (`/charges/{app}/pricing_plans`). Requires managed pricing + public plans in Partner Dashboard.
 * - `SHOPIFY_BILLING_MODE=api` — only this exact value enables Billing API (`appSubscriptionCreate`) in-app.
 *   Use for local/dev only when the app is not registered as managed pricing in Partners.
 */
export function getBillingMode(): BillingMode {
  const mode = (process.env.SHOPIFY_BILLING_MODE ?? "").trim().toLowerCase();
  if (mode === "api") {
    return "api";
  }
  return DEFAULT_BILLING_MODE;
}

/** Admin URL segment: /admin/store/.../apps/{handle}/... — usually matches app name; override if yours differs. */
export function getAppAdminHandle(): string {
  return process.env.SHOPIFY_APP_HANDLE?.trim() || "printdock";
}

export function getManagedPricingPlanSelectionUrl(
  shopDomain: string,
  appHandle: string,
): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}
