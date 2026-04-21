import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import type { PlanCode } from "../config/plans";
import {
  billableLinesCollection,
  getEffectiveBillingPlan,
  jobsCollection,
} from "./shop-data.server";

const USAGE_FEE_BPS: Partial<Record<PlanCode, { bps: number; cap: number }>> = {
  pro: { bps: 75, cap: 200 },
  business: { bps: 50, cap: 500 },
};

export async function processBillableOrder(shopDomain: string, order: any) {
  const billingPlan = await getEffectiveBillingPlan(shopDomain);
  if (billingPlan.status !== "active") return;

  const usageFee = USAGE_FEE_BPS[billingPlan.planCode];
  if (!usageFee) return;
  const percentageRateBps = usageFee.bps;

  for (const line of order.line_items) {
    const sessionToken = line.properties?.find(
      (p: any) => p.name === "_uc_session",
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
            ].includes(String(p?.name || "")),
          )
        : false;
      if (hasPrintDockHints) {
        log.warn("billing_missing_uc_session", "PrintDock line hints without _uc_session", {
          shopDomain,
          orderId: String(order.id),
          lineItemId: String(line.id),
        });
      }
      continue;
    }

    const jobId = `${order.id}_${line.id}`;
    let jobDoc = await jobsCollection(shopDomain).doc(jobId).get();
    if (!jobDoc.exists) {
      jobDoc = await db.collection("jobs").doc(jobId).get();
    }

    if (!jobDoc.exists) {
      log.warn("billing_job_not_found", "No order job for billable line", {
        shopDomain,
        orderId: String(order.id),
        lineItemId: String(line.id),
        sessionToken: String(sessionToken),
      });
      continue;
    }

    const billableLineId = `${jobId}_billing`;
    const existing = await billableLinesCollection(shopDomain).doc(billableLineId).get();
    if (existing.exists) continue;

    const amount = Number(line.price ?? 0) * Number(line.quantity ?? 1);
    const computedFee = amount * (percentageRateBps / 10000);

    await billableLinesCollection(shopDomain).doc(billableLineId).set(
      {
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
      },
      { merge: true },
    );
  }
}
