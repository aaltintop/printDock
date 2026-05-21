import type { ShopifyVariantRow } from "../utils/field-target-product-variants-ui";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

function extractNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function toProductGid(productId: string): string {
  return productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
}

function assertGraphqlOk(json: { errors?: Array<{ message?: string }> }) {
  if (!json.errors?.length) return;
  const message = json.errors.map((error) => error.message ?? "GraphQL error").join("; ");
  throw new Error(message);
}

async function fetchVariantsForProduct(
  admin: AdminLike,
  productGid: string,
): Promise<Array<{ id: string; title: string; sku: string }>> {
  const variants: Array<{ id: string; title: string; sku: string }> = [];
  let after: string | null = null;

  for (;;) {
    const response = await admin.graphql(
      `#graphql
      query PrintDockProductVariants($id: ID!, $first: Int!, $after: String) {
        product(id: $id) {
          id
          variants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                sku
                displayName
              }
            }
          }
        }
      }`,
      {
        variables: {
          id: productGid,
          first: 250,
          after,
        },
      },
    );
    const json = await response.json();
    assertGraphqlOk(json);
    const connection = json?.data?.product?.variants;
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.id) continue;
      variants.push({
        id: String(node.id),
        title: String(node.displayName ?? node.title ?? ""),
        sku: String(node.sku ?? ""),
      });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? null;
    if (!after) break;
  }

  return variants;
}

export async function fetchProductVariants(
  admin: AdminLike,
  productIds: string[],
): Promise<ShopifyVariantRow[]> {
  const uniqueIds = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const rows: ShopifyVariantRow[] = [];
  for (const productId of uniqueIds) {
    const productGid = toProductGid(productId);
    const variants = await fetchVariantsForProduct(admin, productGid);
    for (const variant of variants) {
      rows.push({
        productId: extractNumericId(productGid),
        variantId: extractNumericId(variant.id),
        title: variant.title,
        sku: variant.sku,
      });
    }
  }

  return rows;
}
