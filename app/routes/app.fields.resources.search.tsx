import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  searchTargetResources,
  type TargetResourceKind,
} from "../services/target-resource-search.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function parseKind(raw: string | null): TargetResourceKind | null {
  if (raw === "product" || raw === "collection") return raw;
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { admin, session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const url = new URL(request.url);
    const kind = parseKind(url.searchParams.get("kind"));
    if (!kind) {
      return data({ error: "Invalid resource kind" }, { status: 400 });
    }

    const query = url.searchParams.get("query") ?? "";
    const after = url.searchParams.get("after");

    try {
      const result = await searchTargetResources(admin, kind, { query, after });
      return data(result);
    } catch (err) {
      log.error("target_resource_search_failed", err, { kind });
      return data({ error: "Failed to load resources" }, { status: 500 });
    }
  });
};
