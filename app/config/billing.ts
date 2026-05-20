/**
 * Managed app pricing (Partner Dashboard) uses Shopify-hosted plan selection.
 *
 * Billing `test` / `isTest` for any future Billing API calls: use
 * {@link resolveBillingTestMode} from `app/services/billing.server.ts`.
 *
 * @see https://shopify.dev/docs/apps/launch/billing/managed-pricing
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
