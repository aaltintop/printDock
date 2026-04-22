import type { ActionFunctionArgs } from "react-router";
import { isRecognizedSubscriptionName, planCodeFromSubscriptionName } from "../config/plans";
import { authenticate } from "../shopify.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import { saveBillingPlan, updateShopPlan } from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { shop, payload } = await authenticate.webhook(request);
      setLogShopDomain(shop);
      log.event("webhook_received", { topic: "APP_SUBSCRIPTIONS_UPDATE", shopDomain: shop });

      const subscription = payload as {
        app_subscription?: {
          name?: string;
          status?: string;
          admin_graphql_api_id?: string;
        };
      };

      const sub = subscription.app_subscription;
      if (!sub) {
        log.warn("subscription_update_missing_payload", "Missing app_subscription in payload", {
          shopDomain: shop,
        });
        return new Response("OK", { status: 200 });
      }

      const subscriptionName = String(sub.name ?? "");
      const status = String(sub.status ?? "").toUpperCase();
      const subscriptionId = sub.admin_graphql_api_id ?? null;

      log.event("subscription_update_received", {
        shopDomain: shop,
        subscriptionName,
        status,
        subscriptionId: subscriptionId ?? "",
      });

      if (
        status === "CANCELLED" ||
        status === "DECLINED" ||
        status === "EXPIRED" ||
        status === "FROZEN" ||
        status === "ON_HOLD"
      ) {
        await updateShopPlan(shop, "free");
        await saveBillingPlan(shop, {
          planCode: "free",
          status: "inactive",
          subscriptionId: null,
        });
        log.event("webhook_processed", { topic: "APP_SUBSCRIPTIONS_UPDATE", shopDomain: shop });
        return new Response("OK", { status: 200 });
      }

      const planCode = planCodeFromSubscriptionName(subscriptionName);

      if (status === "ACTIVE" || status === "ACCEPTED") {
        if (
          planCode === "free" &&
          subscriptionName.trim().length > 0 &&
          !isRecognizedSubscriptionName(subscriptionName)
        ) {
          log.warn(
            "subscription_name_unrecognized",
            `No plan mapping for subscription name: ${subscriptionName}`,
            { shopDomain: shop, subscriptionName, status },
          );
        }
        await updateShopPlan(shop, planCode);
        await saveBillingPlan(shop, {
          planCode,
          status: "active",
          subscriptionId,
        });
      } else if (status === "PENDING") {
        if (
          planCode === "free" &&
          subscriptionName.trim().length > 0 &&
          !isRecognizedSubscriptionName(subscriptionName)
        ) {
          log.warn(
            "subscription_name_unrecognized",
            `No plan mapping for subscription name: ${subscriptionName}`,
            { shopDomain: shop, subscriptionName, status },
          );
        }
        await saveBillingPlan(shop, {
          planCode,
          status: "trial",
          subscriptionId,
        });
      } else {
        log.warn("subscription_update_unhandled_status", `Unhandled subscription status: ${status}`, {
          shopDomain: shop,
          subscriptionName,
          status,
        });
      }

      log.event("webhook_processed", { topic: "APP_SUBSCRIPTIONS_UPDATE", shopDomain: shop });
      return new Response("OK", { status: 200 });
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("webhook_app_subscriptions_update_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
};
