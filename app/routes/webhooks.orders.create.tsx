import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { rethrowIfShopifyWebhookResponse } from "../lib/webhook-action.server";
import { mergeOrderJob } from "../services/shop-data.server";
import {
  buildOrderIngestId,
  enqueueOrderIngest,
} from "../services/order-ingest-queue.server";
import { kickOrderIngestItem } from "../services/order-ingest-kick.server";
import { buildPlaceholderJob, enrichJobWithIngestPreview } from "../services/order-ingest.server";

type OrderLineProperty = {
  name?: string;
  value?: string;
};

type OrdersCreateLine = {
  id?: string | number;
  quantity?: number;
  variant_title?: string;
  title?: string;
  properties?: OrderLineProperty[];
};

type OrdersCreatePayload = {
  id?: string | number;
  name?: string;
  line_items?: OrdersCreateLine[];
  note_attributes?: OrderLineProperty[];
};

type PriceMapEntry = { sid?: string; token?: string };

function priceMapFromCartAttributeJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw)) as PriceMapEntry[];
    if (!Array.isArray(parsed)) return {};
    return parsed.reduce(
      (acc: Record<string, string>, entry) => {
        const sid = String(entry?.sid || "").trim();
        const token = String(entry?.token || "").trim();
        if (!sid || !token) return acc;
        acc[sid] = token;
        return acc;
      },
      {} as Record<string, string>,
    );
  } catch {
    return {};
  }
}

function parseSignedPriceMap(noteAttributes: OrderLineProperty[] | undefined): Record<string, string> {
  const legacy = priceMapFromCartAttributeJson(
    noteAttributes?.find((attr) => attr.name === "__pd_price_map")?.value,
  );
  const primary = priceMapFromCartAttributeJson(
    noteAttributes?.find((attr) => attr.name === "_pd_price_map")?.value,
  );
  return { ...legacy, ...primary };
}

function linePropsSnapshot(props: OrderLineProperty[] | undefined) {
  return (props ?? []).map((prop) => ({
    name: String(prop.name ?? ""),
    value: String(prop.value ?? ""),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { topic, shop, payload } = await authenticate.webhook(request);

      if (topic !== "ORDERS_CREATE") {
        return new Response("Ignored", { status: 200 });
      }

      const order = payload as OrdersCreatePayload;
      const shopDomain = shop;
      setLogShopDomain(shopDomain);
      log.event("webhook_received", { topic, shopDomain });
      log.event("orders_create_received", {
        shopDomain,
        orderId: String(order.id),
        lineItemCount: Array.isArray(order.line_items) ? order.line_items.length : 0,
      });

      const signedPriceMapBySession = parseSignedPriceMap(order.note_attributes);

      for (const line of order.line_items ?? []) {
        const props = line.properties ?? [];
        const sessionToken = props.find((p) => p.name === "_uc_session")?.value;
        if (!sessionToken) {
          const hasPrintDockHints = props.some((p) =>
            [
              "_pd_session",
              "__ucToken",
              "_Artwork",
              "Artwork",
              "Print Ready File",
              "View uploads",
              "__View uploads",
            ].includes(String(p?.name || "")),
          );
          if (hasPrintDockHints) {
            log.warn("orders_create_missing_uc_session", "PrintDock hints without session token", {
              shopDomain,
              orderId: String(order.id),
              lineItemId: String(line.id),
              propertyNames: props.map((p) => String(p?.name || "")).slice(0, 20),
            });
          }
          continue;
        }

        const shopifyOrderId = String(order.id);
        const shopifyLineItemId = String(line.id);
        const ingestId = buildOrderIngestId(shopifyOrderId, shopifyLineItemId);
        const jobId = `${shopifyOrderId}_${shopifyLineItemId}_0`;
        const snapshot = linePropsSnapshot(props);

        const placeholder = buildPlaceholderJob({
          shopDomain,
          jobId,
          shopifyOrderId,
          shopifyOrderName: String(order.name ?? ""),
          shopifyLineItemId,
          sessionToken: String(sessionToken),
          lineItemProps: snapshot,
        });
        await mergeOrderJob(shopDomain, jobId, placeholder);
        await enrichJobWithIngestPreview(shopDomain, jobId, String(sessionToken), snapshot);

        await enqueueOrderIngest({
          id: ingestId,
          shopDomain,
          shopifyOrderId,
          shopifyOrderName: String(order.name ?? ""),
          shopifyLineItemId,
          sessionToken: String(sessionToken),
          jobId,
          lineItemProps: snapshot,
          signedPriceMapBySession,
          lineTitle: String(line.title ?? ""),
          lineVariantTitle: String(line.variant_title ?? ""),
          perFileQuantity: Number(line.quantity || 1),
        });

        log.event("orders_create_ingest_enqueued", {
          shopDomain,
          orderId: shopifyOrderId,
          lineItemId: shopifyLineItemId,
          ingestId,
          jobId,
        });

        void kickOrderIngestItem(shopDomain, ingestId);
      }

      log.event("webhook_processed", { topic: "ORDERS_CREATE", shopDomain });
      return new Response("OK", { status: 200 });
    } catch (err) {
      rethrowIfShopifyWebhookResponse(err);
      log.error("webhook_orders_create_failed", err, {});
      return new Response("Error", { status: 500 });
    }
  });
}
