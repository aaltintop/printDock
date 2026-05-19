import { db } from "../firebase.server";
import { log } from "../lib/logger.server";

const SYSTEM_COLLECTION = "system";
const FEE_PRODUCT_DOC = "feeProduct";
/** Shown on cart, checkout, and receipts — keep unbranded (not "PrintDock …"). */
const FEE_PRODUCT_TITLE = "Artwork upload fee";
const LEGACY_FEE_PRODUCT_TITLES = ["PrintDock Upload Fee"];
const FEE_TAG = "printdock-internal-fee";
const ONLINE_STORE_CATALOG_TITLE = "online store";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type FeeProductRecord = {
  productGid: string;
  variantGid: string;
  /** Numeric variant id for Theme `/cart/add.js` */
  variantId: string;
};

function feeProductDocRef(shopDomain: string) {
  return db.collection("shops").doc(shopDomain).collection(SYSTEM_COLLECTION).doc(FEE_PRODUCT_DOC);
}

function gidToNumericId(gid: string): string {
  const m = String(gid || "").match(/\/(\d+)\s*$/);
  return m ? m[1] : "";
}

export async function getFeeProductFromFirestore(
  shopDomain: string,
): Promise<FeeProductRecord | null> {
  const snap = await feeProductDocRef(shopDomain).get();
  if (!snap.exists) return null;
  const raw = snap.data() as Partial<FeeProductRecord>;
  const variantId = String(raw.variantId || "").trim();
  const variantGid = String(raw.variantGid || "").trim();
  const productGid = String(raw.productGid || "").trim();
  if (!variantId || !variantGid || !productGid) return null;
  return { productGid, variantGid, variantId };
}

async function persistFeeProduct(shopDomain: string, record: FeeProductRecord): Promise<void> {
  await feeProductDocRef(shopDomain).set(
    { ...record, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

async function clearFeeProductFromFirestore(shopDomain: string): Promise<void> {
  await feeProductDocRef(shopDomain).delete();
}

async function getOnlineStorePublicationId(admin: AdminLike): Promise<string | null> {
  const res = await admin.graphql(`#graphql
    query PrintDockOnlineStorePublication {
      publications(first: 20, catalogType: APP) {
        nodes {
          id
          catalog {
            title
          }
        }
      }
    }
  `);
  const json = await res.json();
  const nodes = Array.isArray(json?.data?.publications?.nodes)
    ? json.data.publications.nodes
    : [];
  const match = nodes.find((node: { catalog?: { title?: string } }) => {
    const title = String(node?.catalog?.title || "").trim().toLowerCase();
    return title === ONLINE_STORE_CATALOG_TITLE;
  });
  const publicationId = String(match?.id || nodes[0]?.id || "").trim();
  return publicationId || null;
}

async function publishProductToOnlineStore(admin: AdminLike, productGid: string): Promise<void> {
  const publicationId = await getOnlineStorePublicationId(admin);
  if (!publicationId) {
    throw new Error("Online Store publication not found");
  }

  const publishRes = await admin.graphql(
    `#graphql
    mutation PrintDockPublishFeeProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          ... on Product {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        id: productGid,
        input: [{ publicationId }],
      },
    },
  );
  const publishJson = await publishRes.json();
  const userErrors = Array.isArray(publishJson?.data?.publishablePublish?.userErrors)
    ? publishJson.data.publishablePublish.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = String(userErrors[0]?.message || "publishablePublish failed");
    throw new Error(`Could not publish upload fee product to Online Store: ${msg}`);
  }
}

function isPublishedToOnlineStore(
  resourcePublications: Array<{
    isPublished?: boolean;
    publication?: { catalog?: { title?: string } };
  }>,
): boolean {
  return resourcePublications.some((entry) => {
    if (!entry?.isPublished) return false;
    const title = String(entry?.publication?.catalog?.title || "").trim().toLowerCase();
    return title === ONLINE_STORE_CATALOG_TITLE;
  });
}

async function syncFeeProductTitle(admin: AdminLike, productGid: string, currentTitle: string): Promise<void> {
  const normalized = String(currentTitle || "").trim();
  if (normalized === FEE_PRODUCT_TITLE) return;
  if (normalized && !LEGACY_FEE_PRODUCT_TITLES.includes(normalized)) return;

  const updateRes = await admin.graphql(
    `#graphql
    mutation PrintDockRenameFeeProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        product: {
          id: productGid,
          title: FEE_PRODUCT_TITLE,
        },
      },
    },
  );
  const updateJson = await updateRes.json();
  const userErrors = Array.isArray(updateJson?.data?.productUpdate?.userErrors)
    ? updateJson.data.productUpdate.userErrors
    : [];
  if (userErrors.length > 0) {
    log.warn("fee_product_title_sync_failed", String(userErrors[0]?.message || "productUpdate failed"), {
      productGid,
    });
  }
}

async function setFeeVariantPriceZero(admin: AdminLike, productGid: string, variantGid: string): Promise<void> {
  const updateRes = await admin.graphql(
    `#graphql
    mutation PrintDockUpdateFeeVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          legacyResourceId
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        productId: productGid,
        variants: [
          {
            id: variantGid,
            price: "0.00",
            inventoryPolicy: "CONTINUE",
            taxable: true,
          },
        ],
      },
    },
  );
  const updateJson = await updateRes.json();
  const userErrors = Array.isArray(updateJson?.data?.productVariantsBulkUpdate?.userErrors)
    ? updateJson.data.productVariantsBulkUpdate.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = String(userErrors[0]?.message || "productVariantsBulkUpdate failed");
    throw new Error(`Could not configure upload fee variant price: ${msg}`);
  }
}

async function verifyFeeProductRecord(
  admin: AdminLike,
  shopDomain: string,
  record: FeeProductRecord,
): Promise<FeeProductRecord | null> {
  const verifyRes = await admin.graphql(
    `#graphql
    query PrintDockVerifyFeeProduct($id: ID!) {
      product(id: $id) {
        id
        title
        status
        resourcePublications(first: 20) {
          nodes {
            isPublished
            publication {
              id
              catalog {
                title
              }
            }
          }
        }
        variants(first: 1) {
          nodes {
            id
            legacyResourceId
          }
        }
      }
    }`,
    { variables: { id: record.productGid } },
  );
  const verifyJson = await verifyRes.json();
  const product = verifyJson?.data?.product;
  if (!product?.id) {
    log.warn("fee_product_missing_in_shopify", "Stored fee product no longer exists", {
      shopDomain,
      productGid: record.productGid,
    });
    await clearFeeProductFromFirestore(shopDomain);
    return null;
  }

  const variantNode = product?.variants?.nodes?.[0];
  const variantGid = String(variantNode?.id || record.variantGid || "").trim();
  const variantId =
    String(variantNode?.legacyResourceId || "").trim() ||
    gidToNumericId(variantGid) ||
    record.variantId;
  if (!variantGid || !variantId) {
    log.warn("fee_product_variant_missing", "Fee product exists but variant id is unavailable", {
      shopDomain,
      productGid: record.productGid,
    });
    await clearFeeProductFromFirestore(shopDomain);
    return null;
  }

  const resourcePublications = Array.isArray(product?.resourcePublications?.nodes)
    ? product.resourcePublications.nodes
    : [];
  if (!isPublishedToOnlineStore(resourcePublications)) {
    await publishProductToOnlineStore(admin, record.productGid);
  }

  await syncFeeProductTitle(admin, record.productGid, String(product?.title || ""));

  const healed: FeeProductRecord = {
    productGid: String(product.id),
    variantGid,
    variantId,
  };
  if (
    healed.productGid !== record.productGid ||
    healed.variantGid !== record.variantGid ||
    healed.variantId !== record.variantId
  ) {
    await persistFeeProduct(shopDomain, healed);
  }
  return healed;
}

/**
 * Hidden $0 variant used only for dynamic upload fees. The storefront adds it as a
 * @deprecated v1.0.8+ uses Build A (single-line lineExpand). Kept for reference;
 * new installs no longer call ensureFeeProduct. Legacy second cart line; Cart Transform
 * lineExpand reprices that line only so the artwork
 * line stays a normal line item (clickable Print Ready File in Admin).
 *
 * The fee product must be published to Online Store or `/cart/add.js` returns
 * "Cannot find variant" for the fee line.
 */
export async function ensureFeeProduct(
  admin: AdminLike,
  shopDomain: string,
): Promise<FeeProductRecord> {
  const existing = await getFeeProductFromFirestore(shopDomain);
  if (existing) {
    const verified = await verifyFeeProductRecord(admin, shopDomain, existing);
    if (verified) return verified;
  }

  const createRes = await admin.graphql(
    `#graphql
    mutation PrintDockCreateFeeProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          variants(first: 1) {
            nodes {
              id
              legacyResourceId
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        product: {
          title: FEE_PRODUCT_TITLE,
          status: "UNLISTED",
          tags: [FEE_TAG],
        },
      },
    },
  );
  const createJson = await createRes.json();
  const userErrors = Array.isArray(createJson?.data?.productCreate?.userErrors)
    ? createJson.data.productCreate.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = String(userErrors[0]?.message || "productCreate failed");
    throw new Error(`Could not create upload fee product: ${msg}`);
  }

  const product = createJson?.data?.productCreate?.product;
  const variantNode = product?.variants?.nodes?.[0];
  const productGid = String(product?.id || "");
  const variantGid = String(variantNode?.id || "");
  const variantId =
    String(variantNode?.legacyResourceId || "").trim() || gidToNumericId(variantGid);
  if (!productGid || !variantGid || !variantId) {
    throw new Error("Fee product created but variant id was missing from the response");
  }

  await setFeeVariantPriceZero(admin, productGid, variantGid);
  await publishProductToOnlineStore(admin, productGid);

  const record: FeeProductRecord = { productGid, variantGid, variantId };
  await persistFeeProduct(shopDomain, record);
  log.event("fee_product_created", { shopDomain, variantId });
  return record;
}
