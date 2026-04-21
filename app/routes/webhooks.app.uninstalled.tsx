import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { purgeShopStorageAndFirestore } from "../services/storage-retention.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { shop, session, topic } = await authenticate.webhook(request);
      setLogShopDomain(shop);
      log.event("webhook_received", { topic, shopDomain: shop });

      try {
        const purgeResult = await purgeShopStorageAndFirestore(shop);
        log.event("webhook_app_uninstalled_purge", {
          shopDomain: shop,
          storageObjectsDeleted: purgeResult.storageObjectsDeleted,
        });
      } catch (err) {
        log.error("webhook_app_uninstalled_purge_failed", err, { shopDomain: shop });
      }

      if (session) {
        const snapshot = await db.collection("shopify_sessions").where("shop", "==", shop).get();
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }

      log.event("webhook_processed", { topic, shopDomain: shop });
      return new Response();
    } catch (err) {
      log.error("webhook_app_uninstalled_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
};
