/**
 * Managed app pricing (Partner Dashboard) uses Shopify-hosted plan selection and
 * forbids creating charges via the Billing API. Manual pricing uses appSubscriptionCreate.
 *
 * @see https://shopify.dev/docs/apps/launch/billing/managed-pricing
 */
export type BillingMode = "managed" | "api";

/**
 * - `SHOPIFY_BILLING_MODE=api` | `managed` when set (case-insensitive).
 * - When unset: **`managed`** — same default locally and in production so behavior matches deploys.
 *   Set `SHOPIFY_BILLING_MODE=api` only when Partner Dashboard uses manual pricing (Billing API).
 */
export function getBillingMode(): BillingMode {
  if (process.env.SHOPIFY_BILLING_MODE?.trim().toLowerCase() === "api") {
    return "api";
  }
  return "managed";
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
