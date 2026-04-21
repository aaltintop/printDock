import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { db } from "../firebase.server";
import { runStorageRetentionForShop } from "../services/storage-retention.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function authorizeCron(request: Request): boolean {
  const secret = process.env.STORAGE_RETENTION_CRON_SECRET?.trim();
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

    const shopsSnap = await db.collection("shops").get();
    const results: Array<{
      shopDomain: string;
      ok: boolean;
      filesDeleted?: number;
      pathsDeleted?: string[];
      jobsUpdated?: number;
      sessionsUpdated?: number;
      error?: string;
    }> = [];

    let totalFilesDeleted = 0;

    for (const doc of shopsSnap.docs) {
      const shopDomain = doc.id;
      setLogShopDomain(shopDomain);
      try {
        const report = await runStorageRetentionForShop(shopDomain);
        totalFilesDeleted += report.filesDeleted;
        results.push({
          shopDomain,
          ok: true,
          filesDeleted: report.filesDeleted,
          pathsDeleted: report.pathsDeleted,
          jobsUpdated: report.jobsUpdated,
          sessionsUpdated: report.sessionsUpdated,
        });
        log.event("cron_retention_shop_ok", {
          shopDomain,
          filesDeleted: report.filesDeleted,
          jobsUpdated: report.jobsUpdated,
          sessionsUpdated: report.sessionsUpdated,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("cron_retention_shop_failed", err, { shopDomain });
        results.push({ shopDomain, ok: false, error: message });
      }
    }

    log.event("cron_retention_run", {
      shopCount: shopsSnap.size,
      totalFilesDeleted,
    });

    return data({
      ok: true,
      shopCount: shopsSnap.size,
      totalFilesDeleted,
      results,
    });
  });
}

export async function loader(args: LoaderFunctionArgs) {
  return runCron(args.request);
}

export async function action(args: ActionFunctionArgs) {
  return runCron(args.request);
}
