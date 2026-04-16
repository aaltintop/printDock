import type { ActionFunctionArgs } from "react-router";
import { planCodeFromSubscriptionName } from "../config/plans";
import { authenticate } from "../shopify.server";
import { saveBillingPlan, updateShopPlan } from "../services/shop-data.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const subscription = payload as {
    app_subscription?: {
      name?: string;
      status?: string;
      admin_graphql_api_id?: string;
    };
  };

  const sub = subscription.app_subscription;
  if (!sub) {
    console.warn(
      JSON.stringify({
        event: "subscription_update_missing_payload",
        shop,
      }),
    );
    return new Response("OK", { status: 200 });
  }

  const subscriptionName = String(sub.name ?? "");
  const status = String(sub.status ?? "").toUpperCase();
  const subscriptionId = sub.admin_graphql_api_id ?? null;

  console.info(
    JSON.stringify({
      event: "subscription_update_received",
      shop,
      subscriptionName,
      status,
      subscriptionId,
    }),
  );

  if (status === "CANCELLED" || status === "DECLINED" || status === "EXPIRED") {
    await updateShopPlan(shop, "free");
    await saveBillingPlan(shop, {
      planCode: "free",
      status: "inactive",
      subscriptionId: null,
    });
    return new Response("OK", { status: 200 });
  }

  const planCode = planCodeFromSubscriptionName(subscriptionName);

  if (status === "ACTIVE") {
    await updateShopPlan(shop, planCode);
    await saveBillingPlan(shop, {
      planCode,
      status: "active",
      subscriptionId,
    });
  } else if (status === "PENDING") {
    await saveBillingPlan(shop, {
      planCode,
      status: "trial",
      subscriptionId,
    });
  }

  return new Response("OK", { status: 200 });
};
