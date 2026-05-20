import { log } from "../lib/logger.server";
import { getOrderJob } from "./shop-data.server";
import {
  buildOrderIngestId,
  claimOrderIngestItem,
  enqueueOrderIngest,
} from "./order-ingest-queue.server";
import { processOrderIngestItem } from "./order-ingest.server";
import { isIngestInProgress } from "../utils/order-job-ingest";

/**
 * Best-effort immediate ingest after webhook enqueue (dev often has no cron).
 * Safe to call without awaiting from webhooks; errors are logged only.
 */
export async function kickOrderIngestItem(shopDomain: string, ingestId: string): Promise<void> {
  let item = await claimOrderIngestItem(shopDomain, ingestId);
  if (!item) {
    const jobId = `${ingestId}_0`;
    const stuckJob = await getOrderJob(shopDomain, jobId);
    if (stuckJob && isIngestInProgress(stuckJob.ingestStatus)) {
      await enqueueOrderIngest({
        id: ingestId,
        shopDomain,
        shopifyOrderId: stuckJob.shopifyOrderId,
        shopifyOrderName: stuckJob.shopifyOrderName,
        shopifyLineItemId: stuckJob.shopifyLineItemId,
        sessionToken: stuckJob.sessionId,
        jobId: stuckJob.id,
        lineItemProps: stuckJob.lineItemPropsSnapshot,
        status: "pending",
        attempts: 0,
      });
      item = await claimOrderIngestItem(shopDomain, ingestId);
      if (item) {
        log.event("order_ingest_kick_requeued", { shopDomain, ingestId, jobId });
      }
    }
  }
  if (!item) return;

  try {
    const outcome = await processOrderIngestItem(item, {
      signedPriceMapBySession: item.signedPriceMapBySession,
      lineTitle: item.lineTitle,
      lineVariantTitle: item.lineVariantTitle,
      perFileQuantity: item.perFileQuantity,
    });
    log.event("order_ingest_kick_finished", { shopDomain, ingestId, jobId: item.jobId, outcome });
  } catch (err) {
    log.error("order_ingest_kick_failed", err, { shopDomain, ingestId, jobId: item.jobId });
  }
}

/** Re-run ingest for a visible order job row (e.g. stuck on pending after approve). */
export async function kickOrderIngestForJob(
  shopDomain: string,
  shopifyOrderId: string,
  shopifyLineItemId: string,
): Promise<void> {
  const ingestId = buildOrderIngestId(shopifyOrderId, shopifyLineItemId);
  await kickOrderIngestItem(shopDomain, ingestId);
}
