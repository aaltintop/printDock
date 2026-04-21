import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { payload, session, topic, shop } = await authenticate.webhook(request);
      setLogShopDomain(shop);
      log.event("webhook_received", { topic, shopDomain: shop });

      const current = payload.current as string[];
      if (session) {
        await db.collection("shopify_sessions").doc(session.id).update({
          scope: current.toString(),
        });
      }

      log.event("webhook_processed", { topic, shopDomain: shop });
      return new Response();
    } catch (err) {
      log.error("webhook_app_scopes_update_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
};
