import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import {
  appendOrderJobAuditEvent,
  listOrderJobsByShopifyOrderIds,
  mergeOrderJob,
} from "../services/shop-data.server";

function isAlreadyApproved(status: string) {
  return status === "approved" || status === "ready_for_production";
}

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { topic, shop, payload } = await authenticate.webhook(request);
      if (topic !== "ORDERS_FULFILLED") {
        return new Response("Ignored", { status: 200 });
      }

      const order = payload as { id?: number | string };
      const shopDomain = shop;
      const shopifyOrderId = Number(order?.id);
      setLogShopDomain(shopDomain);
      log.event("webhook_received", { topic, shopDomain });

      if (!Number.isFinite(shopifyOrderId) || shopifyOrderId <= 0) {
        log.warn("orders_fulfilled_missing_order_id", "ORDERS_FULFILLED without valid order id", {
          shopDomain,
          payloadOrderId: String(order?.id ?? ""),
        });
        return new Response("OK", { status: 200 });
      }

      const jobs = await listOrderJobsByShopifyOrderIds(shopDomain, [shopifyOrderId]);
      if (jobs.length === 0) {
        log.event("orders_fulfilled_no_jobs_found", {
          shopDomain,
          shopifyOrderId: String(shopifyOrderId),
        });
        return new Response("OK", { status: 200 });
      }

      for (const job of jobs) {
        if (isAlreadyApproved(job.status)) continue;

        await mergeOrderJob(shopDomain, job.id, { status: "approved" });
        await appendOrderJobAuditEvent(shopDomain, job.id, {
          eventType: "job_updated",
          message: `status: ${job.status} -> approved (Shopify fulfillment)`,
          metadata: {
            previousStatus: job.status,
            nextStatus: "approved",
            source: "shopify_webhook",
            topic: "ORDERS_FULFILLED",
            shopifyOrderId: String(shopifyOrderId),
          },
          actor: "system:webhook",
        });
      }

      log.event("webhook_processed", {
        topic: "ORDERS_FULFILLED",
        shopDomain,
        shopifyOrderId: String(shopifyOrderId),
        updatedJobs: jobs.filter((job) => !isAlreadyApproved(job.status)).length,
      });
      return new Response("OK", { status: 200 });
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("webhook_orders_fulfilled_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
}
