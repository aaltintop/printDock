import { log } from "../lib/logger.server";

const SHOP_PLAN_QUERY = `#graphql
  query PrintDockBillingTestMode {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }
`;

export type BillingTestModeDeps = {
  nodeEnv?: string;
  fetchPartnerDevelopment?: (shopDomain: string) => Promise<boolean | null>;
};

async function fetchShopPartnerDevelopment(shopDomain: string): Promise<boolean | null> {
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  const response = await admin.graphql(SHOP_PLAN_QUERY);
  const json = (await response.json()) as {
    data?: { shop?: { plan?: { partnerDevelopment?: unknown } } };
  };
  const value = json.data?.shop?.plan?.partnerDevelopment;
  return typeof value === "boolean" ? value : null;
}

/**
 * Single source of truth for Shopify Billing `test` / `isTest` flags.
 *
 * - Non-production → always test (no API call).
 * - Production + partner development store → test.
 * - Production + live merchant store → real charge (`false`).
 * - Any uncertainty → test (never accidentally charge).
 */
export async function resolveBillingTestMode(
  shopDomain: string,
  deps: BillingTestModeDeps = {},
): Promise<boolean> {
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV;

  if (nodeEnv !== "production") {
    return true;
  }

  const fetchPartnerDevelopment = deps.fetchPartnerDevelopment ?? fetchShopPartnerDevelopment;
  let partnerDevelopment: boolean | null;

  try {
    partnerDevelopment = await fetchPartnerDevelopment(shopDomain);
  } catch (err) {
    log.warn(
      "billing_test_mode_shop_plan_lookup_failed",
      err instanceof Error ? err.message : String(err),
      { shopDomain },
    );
    partnerDevelopment = null;
  }

  if (partnerDevelopment === null) {
    log.warn(
      "billing_test_mode_fallback_to_test",
      "Shop plan lookup returned unknown; refusing real charge",
      { shopDomain },
    );
    return true;
  }

  if (partnerDevelopment) {
    return true;
  }

  log.warn(
    "billing_real_charge_mode",
    "Billing test flag is false; a real charge may be created",
    { shopDomain },
  );
  return false;
}
