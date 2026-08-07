import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { db } from "../firebase.server";
import {
  STORAGE_USED_BYTES_FIELD,
  recomputeShopStorageUsageBytes,
} from "../services/shop-data.server";
import { snapshotShopStorageUsage } from "../services/ops-usage.server";
import { usageMonthKey } from "../services/ops-usage.utils";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

/**
 * Writes one storage reading per shop into `shops/{shop}/usageMonthly/{YYYY-MM}`
 * so the ops dashboard can show month-over-month trends. `storageUsedBytes` is
 * only a live counter — without these snapshots there is no history to report.
 *
 * Run daily. Auth: USAGE_SNAPSHOT_CRON_SECRET, or STORAGE_RETENTION_CRON_SECRET.
 */
function authorizeCron(request: Request): boolean {
  const secret =
    process.env.USAGE_SNAPSHOT_CRON_SECRET?.trim() ||
    process.env.STORAGE_RETENTION_CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const header = request.headers.get("x-cron-secret");
  return bearer === secret || header === secret;
}

async function runCron(request: Request) {
  return runWithRequestContext(request, async () => {
    if (!authorizeCron(request)) {
      return data({ error: "Unauthorized" }, { status: 401 });
    }

    const month = usageMonthKey();
    const shopsSnap = await db.collection("shops").get();
    const results: Array<{
      shopDomain: string;
      ok: boolean;
      storageUsedBytes?: number;
      recomputed?: boolean;
      error?: string;
    }> = [];

    let okCount = 0;
    let failCount = 0;
    let totalStorageUsedBytes = 0;

    for (const doc of shopsSnap.docs) {
      const shopDomain = doc.id;
      setLogShopDomain(shopDomain);
      try {
        const raw = doc.data()?.[STORAGE_USED_BYTES_FIELD];
        const hasCounter = typeof raw === "number" && Number.isFinite(raw);
        const storageUsedBytes = hasCounter
          ? Math.max(0, raw as number)
          : await recomputeShopStorageUsageBytes(shopDomain);

        await snapshotShopStorageUsage(shopDomain, storageUsedBytes);

        okCount += 1;
        totalStorageUsedBytes += storageUsedBytes;
        results.push({
          shopDomain,
          ok: true,
          storageUsedBytes,
          recomputed: !hasCounter,
        });
      } catch (err) {
        failCount += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error("cron_usage_snapshot_shop_failed", err, { shopDomain });
        results.push({ shopDomain, ok: false, error: message });
      }
    }

    log.event("cron_usage_snapshot_run", {
      month,
      shopCount: shopsSnap.size,
      okCount,
      failCount,
      totalStorageUsedBytes,
    });

    return data({
      ok: failCount === 0,
      month,
      shopCount: shopsSnap.size,
      okCount,
      failCount,
      totalStorageUsedBytes,
      results,
    });
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => runCron(request);
export const action = async ({ request }: ActionFunctionArgs) => runCron(request);
