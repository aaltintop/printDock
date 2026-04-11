import { db } from "../firebase.server";
import { billableLinesCollection, getBillingPlan, jobsCollection } from "./shop-data.server";

const PLANS = {
  basic_plus: { monthlyFee: 19, percentageBps: 75, cap: 200 }, // 0.75%
  pro_plus: { monthlyFee: 49, percentageBps: 50, cap: 500 }, // 0.50%
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
  const billingPlan = await getBillingPlan(shopDomain);
  if (billingPlan.status !== "active") return;

  const percentageRateBps =
    billingPlan.planCode === "pro_plus"
      ? 50
      : billingPlan.planCode === "basic_plus"
        ? 75
        : 0;
  if (percentageRateBps <= 0) return;

  for (const line of order.line_items) {
    const sessionToken = line.properties?.find(
      (p: any) => p.name === "_uc_session"
    )?.value;

    if (!sessionToken) {
      const hasPrintDockHints = Array.isArray(line.properties)
        ? line.properties.some((p: any) =>
            [
              "_pd_session",
              "_pd_asset_ids",
              "_pd_asset_count",
              "Artwork",
              "_Artwork",
              "_Print Ready File",
              "_View uploads",
              "__ucToken",
            ].includes(
              String(p?.name || ""),
            ),
          )
        : false;
      if (hasPrintDockHints) {
        console.warn(
          JSON.stringify({
            event: "billing_missing_uc_session",
            shopDomain,
            orderId: String(order.id),
            lineItemId: String(line.id),
          }),
        );
      }
      continue;
    }

    // Find the job created for this line
    const jobId = `${order.id}_${line.id}`;
    let jobDoc = await jobsCollection(shopDomain).doc(jobId).get();
    if (!jobDoc.exists) {
      jobDoc = await db.collection("jobs").doc(jobId).get();
    }

    if (!jobDoc.exists) {
      console.warn(
        JSON.stringify({
          event: "billing_job_not_found",
          shopDomain,
          orderId: String(order.id),
          lineItemId: String(line.id),
          sessionToken: String(sessionToken),
        }),
      );
      continue;
    }

    // Idempotency: don't double-bill
    const billableLineId = `${jobId}_billing`;
    const existing = await billableLinesCollection(shopDomain).doc(billableLineId).get();
    if (existing.exists) continue;

    const amount = Number(line.price ?? 0) * Number(line.quantity ?? 1);
    const computedFee = amount * (percentageRateBps / 10000);

    await billableLinesCollection(shopDomain).doc(billableLineId).set({
      shopDomain,
      jobId,
      billingPlanId: billingPlan.subscriptionId ?? null,
      shopifyOrderId: String(order.id),
      lineItemId: String(line.id),
      recognizedAmount: amount,
      currency: order.currency,
      computedFee,
      roundedFee: Math.round(computedFee * 100) / 100,
      recognitionStatus: "recognized",
      recognizedAt: new Date().toISOString(),
    }, { merge: true });
  }
}
