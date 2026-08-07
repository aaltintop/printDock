import type { LoaderFunctionArgs } from "react-router";
import {
  authorizeOpsRequest,
  opsResponseHeaders,
  opsUnauthorizedResponse,
} from "../services/ops-auth.server";
import { OPS_DEFAULT_MONTHS, buildShopOpsDetail } from "../services/ops-report.server";
import { isOpsSortKey } from "../services/ops-report.utils";
import { renderOpsShopHtml } from "../services/ops-html.utils";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

/** Firestore document IDs are free-form, so keep this to plausible shop hosts. */
const SHOP_DOMAIN_SHAPE = /^[a-z0-9][a-z0-9.-]{1,253}$/i;

/**
 * Per-client ops detail: monthly storage and download breakdown plus the plan
 * change trail. Sibling of `/ops` (the `ops_` prefix opts out of nesting).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    if (!authorizeOpsRequest(request)) {
      return opsUnauthorizedResponse(request);
    }

    const shopDomain = String(params.shop || "").trim().toLowerCase();
    if (!SHOP_DOMAIN_SHAPE.test(shopDomain)) {
      return new Response(JSON.stringify({ error: "invalid_shop_domain" }), {
        status: 400,
        headers: opsResponseHeaders("application/json; charset=utf-8"),
      });
    }
    setLogShopDomain(shopDomain);

    const url = new URL(request.url);
    const monthsParam = Number(url.searchParams.get("months") ?? OPS_DEFAULT_MONTHS);
    const sortParam = url.searchParams.get("sort") ?? "storage";
    const wantsJson = url.searchParams.get("format") === "json";

    try {
      const detail = await buildShopOpsDetail(shopDomain, { months: monthsParam });
      const viewOptions = {
        months: detail.monthly.length,
        includeCounts: url.searchParams.get("counts") === "1",
        sortKey: isOpsSortKey(sortParam) ? sortParam : ("storage" as const),
      };

      log.event("ops_shop_detail_viewed", {
        shopDomain,
        months: viewOptions.months,
        format: wantsJson ? "json" : "html",
      });

      if (wantsJson) {
        return new Response(JSON.stringify(detail, null, 2), {
          headers: opsResponseHeaders("application/json; charset=utf-8"),
        });
      }

      return new Response(renderOpsShopHtml(detail, viewOptions), {
        headers: opsResponseHeaders("text/html; charset=utf-8"),
      });
    } catch (err) {
      log.error("ops_shop_detail_failed", err, { shopDomain });
      return new Response(JSON.stringify({ error: "ops_shop_detail_failed" }), {
        status: 500,
        headers: opsResponseHeaders("application/json; charset=utf-8"),
      });
    }
  });
}
