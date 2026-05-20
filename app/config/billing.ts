/**
 * Managed app pricing (Partner Dashboard) uses Shopify-hosted plan selection.
 *
 * @see https://shopify.dev/docs/apps/launch/billing/managed-pricing
 * @see docs/DEV_STORE_BILLING_TESTING.md — dev store $0 private test plans
 */

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
