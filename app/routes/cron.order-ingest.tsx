import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { db } from "../firebase.server";
import {
  claimOrderIngestItem,
  listClaimableOrderIngestIds,
} from "../services/order-ingest-queue.server";
import { processOrderIngestItem, markJobArtworkUnrecoverable } from "../services/order-ingest.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function authorizeCron(request: Request): boolean {
  const secret = process.env.ORDER_INGEST_CRON_SECRET?.trim() || process.env.STORAGE_RETENTION_CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const header = request.headers.get("x-cron-secret");
  return bearer === secret || header === secret;
}

async function runOrderIngestCron(request: Request) {
  return runWithRequestContext(request, async () => {
    if (!authorizeCron(request)) {
      return data({ error: "Unauthorized" }, { status: 401 });
    }

    const shopsSnap = await db.collection("shops").get();
    const results: Array<{ shopDomain: string; processed: number; failed: number }> = [];

    for (const doc of shopsSnap.docs) {
      const shopDomain = doc.id;
      setLogShopDomain(shopDomain);
      let processed = 0;
      let failed = 0;

      const ingestIds = await listClaimableOrderIngestIds(shopDomain, 25);
      for (const ingestId of ingestIds) {
        const item = await claimOrderIngestItem(shopDomain, ingestId);
        if (!item) continue;

        try {
          const outcome = await processOrderIngestItem(item, {
            signedPriceMapBySession: item.signedPriceMapBySession,
            lineTitle: item.lineTitle,
            lineVariantTitle: item.lineVariantTitle,
            perFileQuantity: item.perFileQuantity,
          });
          if (outcome === "complete") processed++;
          else if (outcome === "failed") failed++;
        } catch (err) {
          log.error("order_ingest_item_failed", err, { shopDomain, ingestId });
          if (item.attempts >= 8) {
            await markJobArtworkUnrecoverable(shopDomain, item.jobId, String(err));
            failed++;
          }
        }
      }

      if (processed > 0 || failed > 0) {
        log.event("cron_order_ingest_shop_ok", { shopDomain, processed, failed });
      }
      results.push({ shopDomain, processed, failed });
    }

    return data({ ok: true, results });
  });
}

export async function loader(args: LoaderFunctionArgs) {
  return runOrderIngestCron(args.request);
}

export async function action(args: ActionFunctionArgs) {
  return runOrderIngestCron(args.request);
}
