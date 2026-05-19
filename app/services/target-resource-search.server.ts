export type TargetResourceKind = "product" | "collection";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type TargetResourceSearchItem = {
  id: string;
  title: string;
  handle?: string;
  subtitle: string;
  imageUrl?: string;
};

export type TargetResourceSearchResult = {
  items: TargetResourceSearchItem[];
  hasNextPage: boolean;
  endCursor: string | null;
};

const PAGE_SIZE = 25;

function extractNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function assertGraphqlOk(json: { errors?: Array<{ message?: string }> }) {
  if (!json.errors?.length) return;
  const message = json.errors.map((error) => error.message ?? "GraphQL error").join("; ");
  throw new Error(message);
}

export async function searchTargetResources(
  admin: AdminLike,
  kind: TargetResourceKind,
  options: { query?: string; after?: string | null },
): Promise<TargetResourceSearchResult> {
  const query = (options.query ?? "").trim();
  const after = options.after ?? null;

  if (kind === "product") {
    const response = await admin.graphql(
      `#graphql
      query TargetResourceProducts($first: Int!, $query: String, $after: String) {
        products(first: $first, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              totalInventory
              featuredImage {
                url
              }
            }
          }
        }
      }`,
      {
        variables: {
          first: PAGE_SIZE,
          query: query || null,
          after,
        },
      },
    );
    const json = await response.json();
    assertGraphqlOk(json);
    const connection = json?.data?.products;
    const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    const items: TargetResourceSearchItem[] = edges.map(
      (edge: { node?: Record<string, unknown> }) => {
        const node = edge.node ?? {};
        const inventory = Number(node.totalInventory ?? 0);
        const inventoryLabel = Number.isFinite(inventory)
          ? `${inventory} in stock`
          : "Product";
        return {
          id: extractNumericId(String(node.id ?? "")),
          title: String(node.title ?? ""),
          handle: String(node.handle ?? ""),
          subtitle: inventoryLabel,
          imageUrl: typeof node.featuredImage === "object" && node.featuredImage !== null
            ? String((node.featuredImage as { url?: string }).url ?? "")
            : undefined,
        };
      },
    );
    return {
      items,
      hasNextPage: Boolean(connection?.pageInfo?.hasNextPage),
      endCursor: connection?.pageInfo?.endCursor ?? null,
    };
  }

  const response = await admin.graphql(
    `#graphql
    query TargetResourceCollections($first: Int!, $query: String, $after: String) {
      collections(first: $first, after: $after, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            productsCount {
              count
            }
            image {
              url
            }
          }
        }
      }
    }`,
    {
      variables: {
        first: PAGE_SIZE,
        query: query || null,
        after,
      },
    },
  );
  const json = await response.json();
  assertGraphqlOk(json);
  const connection = json?.data?.collections;
  const edges = Array.isArray(connection?.edges) ? connection.edges : [];
  const items: TargetResourceSearchItem[] = edges.map(
    (edge: { node?: Record<string, unknown> }) => {
      const node = edge.node ?? {};
      const count =
        typeof node.productsCount === "object" && node.productsCount !== null
          ? Number((node.productsCount as { count?: number }).count ?? 0)
          : 0;
      const productLabel = count === 1 ? "1 product" : `${count} products`;
      return {
        id: extractNumericId(String(node.id ?? "")),
        title: String(node.title ?? ""),
        subtitle: productLabel,
        imageUrl:
          typeof node.image === "object" && node.image !== null
            ? String((node.image as { url?: string }).url ?? "")
            : undefined,
      };
    },
  );
  return {
    items,
    hasNextPage: Boolean(connection?.pageInfo?.hasNextPage),
    endCursor: connection?.pageInfo?.endCursor ?? null,
  };
}
