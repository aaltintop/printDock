import type { ActionFunctionArgs } from "react-router";
import { db } from "../firebase.server";
import { processBillableOrder } from "../services/billing.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  // authenticate.webhook handles HMAC verification automatically
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Ignored", { status: 200 });
  }

  const order = payload as any;
  const shopDomain = shop;

  // Process each line item
  for (const line of order.line_items) {
    const props = line.properties ?? [];
    const sessionToken = props.find((p: any) => p.name === "_uc_session")?.value;
    if (!sessionToken) continue;

    // Find the session
    const sessionDoc = await db.collection("sessions").doc(sessionToken).get();
    if (!sessionDoc.exists) continue;
    const sessionData = sessionDoc.data();
    if (!sessionData || !sessionData.asset) continue;

    // Idempotency: use orderId_lineItemId as document ID
    const jobId = `${order.id}_${line.id}`;
    
    // Create or update the OrderJob (merge: true handles idempotency)
    await db.collection("jobs").doc(jobId).set({
      shopDomain,
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      shopifyLineItemId: String(line.id),
      sessionId: sessionToken,
      customerEmail: order.email || "N/A",
      shippingAddress: order.shipping_address || null,
      productId: sessionData.productId,
      variantId: sessionData.variantId,
      assetSnapshot: sessionData.asset,
      lineItemPropsSnapshot: props,
      status: "uploaded",
      createdAt: new Date().toISOString(),
    }, { merge: true });

    // Mark session as converted
    await db.collection("sessions").doc(sessionToken).update({
      status: "converted",
    });
  }

  // Process billing
  await processBillableOrder(shopDomain, order);

  return new Response("OK", { status: 200 });
}
