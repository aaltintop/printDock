/**
 * Pure helpers for shop storefront hostnames. Kept free of Shopify / Firebase
 * imports so ops HTML rendering stays unit-testable.
 */

/**
 * Normalize a Shopify primary-domain host to a bare hostname.
 * Rejects anything that is not a plausible host so ops HTML never emits unsafe hrefs.
 */
export function normalizeShopPrimaryHost(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  let host = String(raw).trim().toLowerCase();
  host = host.replace(/^https?:\/\//i, "");
  host = host.split("/")[0] ?? "";
  host = host.replace(/:\d+$/, "");
  if (host.length < 3 || host.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
  if (host.includes("..")) return null;
  return host;
}

/** Public storefront origin for a shop (custom primary domain when known). */
export function shopStorefrontUrl(
  primaryHost: string | null | undefined,
  shopDomain: string,
): string {
  const host =
    normalizeShopPrimaryHost(primaryHost) ||
    normalizeShopPrimaryHost(shopDomain) ||
    String(shopDomain || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
  return `https://${host}`;
}
