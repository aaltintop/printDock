import { db } from "../firebase.server";

const PLANS = {
  starter: { monthlyFee: 19, percentageBps: 75, cap: 200 },  // 0.75%
  growth:  { monthlyFee: 49, percentageBps: 50, cap: 500 },  // 0.50%
  pro:     { monthlyFee: 99, percentageBps: 30, cap: 1000 }, // 0.30%
} as const;

// Create a Shopify app subscription (recurring + usage) via GraphQL
export async function createSubscription(
  admin: any, // Shopify GraphQL admin client
  planCode: keyof typeof PLANS,
  returnUrl: string
) {
  const plan = PLANS[planCode];

  const response = await admin.graphql(`
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: false) {
        confirmationUrl
        appSubscription { id }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      name: `PrintDock ${planCode.charAt(0).toUpperCase() + planCode.slice(1)}`,
      returnUrl,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.monthlyFee, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
        {
          plan: {
            appUsagePricingDetails: {
              terms: `${plan.percentageBps / 100}% of uploader-generated sales`,
              cappedAmount: { amount: plan.cap, currencyCode: "USD" },
            },
          },
        },
      ],
    },
  });

  const data = await response.json();
  return data.data.appSubscriptionCreate;
}

// Called after orders/create webhook — record billable line items
export async function processBillableOrder(
  shopDomain: string,
  order: any // Shopify order payload
) {
  const billingPlanDoc = await db.collection("billingPlans").doc(shopDomain).get();
  if (!billingPlanDoc.exists) return;
  const billingPlan = billingPlanDoc.data();
  if (!billingPlan || billingPlan.status !== "active") return;

  for (const line of order.line_items) {
    const sessionToken = line.properties?.find(
      (p: any) => p.name === "_uc_session"
    )?.value;

    if (!sessionToken) continue;

    // Find the job created for this line
    const jobId = `${order.id}_${line.id}`;
    const jobDoc = await db.collection("jobs").doc(jobId).get();

    if (!jobDoc.exists) continue;

    // Idempotency: don't double-bill
    const billableLineId = `${jobId}_billing`;
    const existing = await db.collection("billableLines").doc(billableLineId).get();
    if (existing.exists) continue;

    const amount = parseFloat(line.price) * line.quantity;
    const computedFee = amount * (billingPlan.percentageRateBps / 10000);

    await db.collection("billableLines").doc(billableLineId).set({
      shopDomain,
      jobId,
      billingPlanId: billingPlan.subscriptionId,
      shopifyOrderId: String(order.id),
      lineItemId: String(line.id),
      recognizedAmount: amount,
      currency: order.currency,
      computedFee,
      roundedFee: Math.round(computedFee * 100) / 100,
      recognitionStatus: "recognized",
      recognizedAt: new Date().toISOString(),
    });
  }
}
