import { log } from "../lib/logger.server";
import { unauthenticated } from "../shopify.server";
import { shopDoc } from "./shop-data.server";
import { normalizeShopPrimaryHost } from "./shop-domain.utils";

export { normalizeShopPrimaryHost, shopStorefrontUrl } from "./shop-domain.utils";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const SHOP_PRIMARY_DOMAIN_QUERY = `#graphql
  query PrintDockShopPrimaryDomain {
    shop {
      primaryDomain {
        host
        url
      }
    }
  }
`;

export async function fetchShopPrimaryHost(admin: AdminLike): Promise<string | null> {
  const response = await admin.graphql(SHOP_PRIMARY_DOMAIN_QUERY);
  const json = (await response.json()) as {
    data?: { shop?: { primaryDomain?: { host?: unknown; url?: unknown } | null } };
  };
  const primary = json.data?.shop?.primaryDomain;
  return (
    normalizeShopPrimaryHost(primary?.host) ||
    normalizeShopPrimaryHost(primary?.url)
  );
}

/**
 * Persist `shops/{shop}.primaryDomain` (bare host) from Admin GraphQL.
 * Returns the host written, or null when Shopify had none / the call failed.
 */
export async function syncShopPrimaryDomain(
  shopDomain: string,
  admin: AdminLike,
): Promise<string | null> {
  const shop = shopDomain.trim().toLowerCase();
  if (!shop) return null;
  try {
    const primaryDomain = await fetchShopPrimaryHost(admin);
    await shopDoc(shop).set(
      {
        primaryDomain,
        primaryDomainUpdatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    return primaryDomain;
  } catch (err) {
    log.error("shop_primary_domain_sync_failed", err, { shopDomain: shop });
    return null;
  }
}

/**
 * When ops has no cached primary domain, try one offline Admin fetch and cache it.
 * Failures are swallowed so the dashboard still renders.
 */
export async function ensureShopPrimaryDomain(
  shopDomain: string,
  cached: string | null | undefined,
): Promise<string | null> {
  const existing = normalizeShopPrimaryHost(cached);
  if (existing) return existing;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    return await syncShopPrimaryDomain(shopDomain, admin);
  } catch (err) {
    log.error("shop_primary_domain_ensure_failed", err, { shopDomain });
    return null;
  }
}
