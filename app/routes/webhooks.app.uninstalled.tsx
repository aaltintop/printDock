import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import { purgeShopStorageFirestoreAndSessions } from "../services/storage-retention.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { shop, topic } = await authenticate.webhook(request);
      setLogShopDomain(shop);
      log.event("webhook_received", { topic, shopDomain: shop });

      try {
        const purgeResult = await purgeShopStorageFirestoreAndSessions(shop);
        log.event("webhook_app_uninstalled_purge", {
          shopDomain: shop,
          storageObjectsDeleted: purgeResult.storageObjectsDeleted,
        });
      } catch (err) {
        log.error("webhook_app_uninstalled_purge_failed", err, { shopDomain: shop });
      }

      log.event("webhook_processed", { topic, shopDomain: shop });
      return new Response();
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("webhook_app_uninstalled_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
};
