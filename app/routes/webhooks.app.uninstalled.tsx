import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import { purgeShopStorageAndFirestore } from "../services/storage-retention.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const purgeResult = await purgeShopStorageAndFirestore(shop);
    console.log(
      `PrintDock purge for ${shop}: removed ${purgeResult.storageObjectsDeleted} storage object(s)`,
    );
  } catch (err) {
    console.error(`PrintDock purge failed for ${shop}:`, err);
  }

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    const snapshot = await db.collection("shopify_sessions").where("shop", "==", shop).get();
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  }

  return new Response();
};
