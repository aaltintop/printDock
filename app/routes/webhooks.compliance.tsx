import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import { createCustomerDataRequestExport } from "../services/compliance-export.server";
import {
  purgeShopStorageFirestoreAndSessions,
  redactPrintdockJobsForOrderIds,
} from "../services/storage-retention.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { topic, shop, payload } = await authenticate.webhook(request);
      setLogShopDomain(shop);
      log.event("webhook_received", { topic, shopDomain: shop, compliance: true });

      if (topic === "CUSTOMERS_DATA_REQUEST") {
        const p = payload as {
          orders_requested?: number[];
          customer?: { id?: number; email?: string; phone?: string | number };
          data_request?: { id?: number };
        };
        const ordersRequested = Array.isArray(p.orders_requested) ? p.orders_requested : [];
        const exportResult = await createCustomerDataRequestExport({
          shopDomain: shop,
          ordersRequested,
          customer: p.customer ?? {},
          dataRequest: p.data_request ?? {},
        });
        log.event("compliance_customers_data_request", {
          shopDomain: shop,
          customerId: p.customer?.id ?? null,
          orderCount: ordersRequested.length,
          dataRequestId: p.data_request?.id ?? null,
          exportStoragePath: exportResult.storagePath,
          exportJobCount: exportResult.jobCount,
          exportUploadSessionCount: exportResult.uploadSessionCount,
          complianceFirestoreDocId: exportResult.firestoreDocId,
        });
        return new Response(null, { status: 200 });
      }

      if (topic === "CUSTOMERS_REDACT") {
        const p = payload as { orders_to_redact?: number[] };
        const orderIds = Array.isArray(p.orders_to_redact) ? p.orders_to_redact : [];
        const { jobsRemoved } = await redactPrintdockJobsForOrderIds(shop, orderIds);
        log.event("compliance_customers_redact", {
          shopDomain: shop,
          ordersToRedact: orderIds.length,
          jobsRemoved,
        });
        return new Response(null, { status: 200 });
      }

      if (topic === "SHOP_REDACT") {
        const { storageObjectsDeleted } = await purgeShopStorageFirestoreAndSessions(shop);
        log.event("compliance_shop_redact", {
          shopDomain: shop,
          storageObjectsDeleted,
        });
        return new Response(null, { status: 200 });
      }

      log.warn("compliance_webhook_unknown_topic", "Unhandled compliance topic", {
        topic,
        shopDomain: shop,
      });
      return new Response(null, { status: 200 });
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("compliance_webhook_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
};
