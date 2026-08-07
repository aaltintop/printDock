import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { db } from "../firebase.server";
import { unauthenticated } from "../shopify.server";
import { reconcileBillingPlanFromShopifySubscriptions } from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

/**
 * Scheduled reconcile so cancellations / freezes are noticed without an admin visit.
 * Auth: STORAGE_RETENTION_CRON_SECRET (shared with retention cron) or BILLING_RECONCILE_CRON_SECRET.
 */
function authorizeCron(request: Request): boolean {
  const secret =
    process.env.BILLING_RECONCILE_CRON_SECRET?.trim() ||
    process.env.STORAGE_RETENTION_CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const header = request.headers.get("x-cron-secret");
  return bearer === secret || header === secret;
}

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query PrintDockBillingReconcile {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
      }
    }
  }
`;

async function runCron(request: Request) {
  return runWithRequestContext(request, async () => {
    if (!authorizeCron(request)) {
      return data({ error: "Unauthorized" }, { status: 401 });
    }

    const shopsSnap = await db.collection("shops").get();
    const results: Array<{
      shopDomain: string;
      ok: boolean;
      planCode?: string;
      status?: string;
      error?: string;
    }> = [];

    let okCount = 0;
    let failCount = 0;

    for (const doc of shopsSnap.docs) {
      const shopDomain = doc.id;
      setLogShopDomain(shopDomain);
      try {
        const { admin } = await unauthenticated.admin(shopDomain);
        const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
        const json = await response.json();
        const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
        const plan = await reconcileBillingPlanFromShopifySubscriptions(shopDomain, subs, {
          source: "cron",
        });
        okCount += 1;
        results.push({
          shopDomain,
          ok: true,
          planCode: plan.planCode,
          status: plan.status,
        });
        log.event("cron_billing_reconcile_shop_ok", {
          shopDomain,
          planCode: plan.planCode,
          status: plan.status,
        });
      } catch (err) {
        failCount += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error("cron_billing_reconcile_shop_failed", err, { shopDomain });
        results.push({ shopDomain, ok: false, error: message });
      }
    }

    log.event("cron_billing_reconcile_run", {
      shopCount: shopsSnap.size,
      okCount,
      failCount,
    });

    return data({
      shopCount: shopsSnap.size,
      okCount,
      failCount,
      results,
    });
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => runCron(request);
export const action = async ({ request }: ActionFunctionArgs) => runCron(request);
