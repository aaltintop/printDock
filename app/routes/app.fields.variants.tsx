import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchProductVariants } from "../services/product-variants.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { admin, session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const url = new URL(request.url);
    const productIds = url.searchParams
      .getAll("productId")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);

    if (productIds.length === 0) {
      return data({ variants: [] });
    }

    try {
      const variants = await fetchProductVariants(admin, productIds);
      return data({ variants });
    } catch (err) {
      log.error("field_product_variants_load_failed", err, { productIds });
      return data({ error: "Failed to load product variants" }, { status: 500 });
    }
  });
};
