/**
 * Managed app pricing (Partner Dashboard) uses Shopify-hosted plan selection and
 * forbids creating charges via the Billing API. Manual pricing uses appSubscriptionCreate.
 *
 * @see https://shopify.dev/docs/apps/launch/billing/managed-pricing
 */
export type BillingMode = "managed" | "api";

/**
 * - `SHOPIFY_BILLING_MODE=api` — in-app plan buttons use `appSubscriptionCreate` (Billing API / manual pricing).
 * - `SHOPIFY_BILLING_MODE=managed` — buttons open Shopify’s hosted plan page (`/charges/{app}/pricing_plans`).
 * - When unset: **`api`**, because this app implements Billing API charges. Use `managed` only after you enable
 *   managed pricing and public plans in the Partner Dashboard; otherwise Shopify often shows
 *   “This feature isn’t currently available for your store” on the hosted page.
 */
export function getBillingMode(): BillingMode {
  const mode = process.env.SHOPIFY_BILLING_MODE?.trim().toLowerCase();
  if (mode === "managed") return "managed";
  return "api";
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
