import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import {
  claimOrderIngestItem,
} from "../services/order-ingest-queue.server";
import { processOrderIngestItem, markJobArtworkUnrecoverable } from "../services/order-ingest.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function authorizeInternal(request: Request): boolean {
  const secret = process.env.ORDER_INGEST_CRON_SECRET?.trim() || process.env.STORAGE_RETENTION_CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const header = request.headers.get("x-cron-secret");
  return bearer === secret || header === secret;
}

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    if (!authorizeInternal(request)) {
      return data({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      shopDomain?: string;
      ingestId?: string;
      signedPriceMapBySession?: Record<string, string>;
      lineTitle?: string;
      lineVariantTitle?: string;
      perFileQuantity?: number;
    };
    try {
      body = await request.json();
    } catch {
      return data({ error: "bad_request" }, { status: 400 });
    }

    const shopDomain = String(body.shopDomain || "");
    const ingestId = String(body.ingestId || "");
    if (!shopDomain || !ingestId) {
      return data({ error: "bad_request" }, { status: 400 });
    }

    setLogShopDomain(shopDomain);
    const item = await claimOrderIngestItem(shopDomain, ingestId);
    if (!item) {
      return data({ ok: true, skipped: true });
    }

    try {
      const outcome = await processOrderIngestItem(item, {
        signedPriceMapBySession: body.signedPriceMapBySession,
        lineTitle: body.lineTitle,
        lineVariantTitle: body.lineVariantTitle,
        perFileQuantity: body.perFileQuantity,
      });
      return data({ ok: true, outcome });
    } catch (err) {
      log.error("internal_order_ingest_failed", err, { shopDomain, ingestId });
      if (item.attempts >= 8) {
        await markJobArtworkUnrecoverable(shopDomain, item.jobId, String(err));
        return data({ ok: false, outcome: "failed" }, { status: 500 });
      }
      return data({ ok: false, retry: true }, { status: 500 });
    }
  });
}
