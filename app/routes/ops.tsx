import type { LoaderFunctionArgs } from "react-router";
import {
  authorizeOpsRequest,
  opsResponseHeaders,
  opsUnauthorizedResponse,
} from "../services/ops-auth.server";
import { OPS_DEFAULT_MONTHS, buildOpsReport } from "../services/ops-report.server";
import { isOpsSortKey, sortOpsRows } from "../services/ops-report.utils";
import { renderOpsIndexHtml } from "../services/ops-html.utils";
import { log, runWithRequestContext } from "../lib/logger.server";

/**
 * Operator dashboard: every client with plan, install date, storage usage, and
 * download totals, plus monthly history.
 *
 * A resource route (no default export) so the loader owns the whole response —
 * that is what lets the 401 carry `WWW-Authenticate` for the browser Basic
 * prompt and keeps this page free of App Bridge / Polaris.
 *
 * `?format=json` returns the same report for scripting.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    if (!authorizeOpsRequest(request)) {
      return opsUnauthorizedResponse(request);
    }

    const url = new URL(request.url);
    const monthsParam = Number(url.searchParams.get("months") ?? OPS_DEFAULT_MONTHS);
    const includeCounts = url.searchParams.get("counts") === "1";
    const sortParam = url.searchParams.get("sort") ?? "storage";
    const sortKey = isOpsSortKey(sortParam) ? sortParam : "storage";
    const wantsJson = url.searchParams.get("format") === "json";

    try {
      const report = await buildOpsReport({ months: monthsParam, includeCounts });
      const shops = sortOpsRows(report.shops, sortKey);
      const viewOptions = {
        months: report.months.length,
        includeCounts,
        sortKey,
      };

      log.event("ops_dashboard_viewed", {
        shopCount: shops.length,
        months: viewOptions.months,
        includeCounts,
        sortKey,
        format: wantsJson ? "json" : "html",
      });

      if (wantsJson) {
        return new Response(JSON.stringify({ ...report, shops }, null, 2), {
          headers: opsResponseHeaders("application/json; charset=utf-8"),
        });
      }

      return new Response(renderOpsIndexHtml({ ...report, shops }, viewOptions), {
        headers: opsResponseHeaders("text/html; charset=utf-8"),
      });
    } catch (err) {
      log.error("ops_dashboard_failed", err);
      return new Response(JSON.stringify({ error: "ops_dashboard_failed" }), {
        status: 500,
        headers: opsResponseHeaders("application/json; charset=utf-8"),
      });
    }
  });
}
