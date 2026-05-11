import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import { unauthenticated } from "../shopify.server";

export interface FeeVariantConfig {
  variantGid: string;
  variantId: string;
  amountMinorUnits: number;
}

export interface FeeProductConfig {
  productGid: string;
  productId: string;
  currencyCode: string;
  currencyDecimals: number;
  variants: FeeVariantConfig[];
  createdAt: string;
  updatedAt: string;
}

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const TWO_DECIMAL_CODES = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000];
const ZERO_DECIMAL_CODES = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000];
const THREE_DECIMAL_CODES = [1, 5, 10, 50, 100, 1000, 10000, 100000, 1000000];
const CURRENCY_DECIMALS_OVERRIDES: Record<string, number> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

function feeProductDocRef(shopDomain: string) {
  return db.collection("shops").doc(shopDomain).collection("system").doc("feeProduct");
}

function gidToNumericId(gid: string): string {
  return String(gid.split("/").pop() || gid);
}

function moneyScale(decimals: number): number {
  return Math.pow(10, decimals);
}

export function inferCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.toUpperCase();
  return CURRENCY_DECIMALS_OVERRIDES[normalized] ?? 2;
}

export function buildFeeDenominationsMinorUnits(currencyDecimals: number): number[] {
  if (currencyDecimals <= 0) return ZERO_DECIMAL_CODES;
  if (currencyDecimals >= 3) return THREE_DECIMAL_CODES;
  return TWO_DECIMAL_CODES;
}

function toShopAmountFromMinorUnits(amountMinorUnits: number, currencyDecimals: number): string {
  const scale = moneyScale(currencyDecimals);
  return (amountMinorUnits / scale).toFixed(currencyDecimals);
}

function normalizeFeeProductConfig(raw: Record<string, unknown> | undefined): FeeProductConfig | null {
  if (!raw) return null;
  if (typeof raw.productGid !== "string" || typeof raw.productId !== "string") return null;
  if (typeof raw.currencyCode !== "string") return null;
  const currencyDecimals =
    typeof raw.currencyDecimals === "number" && Number.isFinite(raw.currencyDecimals)
      ? raw.currencyDecimals
      : inferCurrencyDecimals(raw.currencyCode);
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) return null;

  const variants: FeeVariantConfig[] = raw.variants
    .map((entry) => {
      const obj = entry as Record<string, unknown>;
      if (
        typeof obj.variantGid !== "string" ||
        typeof obj.variantId !== "string" ||
        typeof obj.amountMinorUnits !== "number"
      ) {
        return null;
      }
      return {
        variantGid: obj.variantGid,
        variantId: obj.variantId,
        amountMinorUnits: obj.amountMinorUnits,
      } as FeeVariantConfig;
    })
    .filter((entry): entry is FeeVariantConfig => Boolean(entry))
    .sort((a, b) => b.amountMinorUnits - a.amountMinorUnits);
  if (variants.length === 0) return null;

  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  return {
    productGid: raw.productGid,
    productId: raw.productId,
    currencyCode: raw.currencyCode,
    currencyDecimals,
    variants,
    createdAt,
    updatedAt,
  };
}

async function fetchShopCurrency(admin: AdminLike): Promise<{ currencyCode: string; currencyDecimals: number }> {
  const response = await admin.graphql(
    `#graphql
    query PrintDockShopCurrency {
      shop {
        currencyCode
      }
    }`,
  );
  const json = await response.json();
  const currencyCode = String(json?.data?.shop?.currencyCode || "USD");
  return { currencyCode, currencyDecimals: inferCurrencyDecimals(currencyCode) };
}

async function createFeeProduct(
  admin: AdminLike,
  currencyCode: string,
  currencyDecimals: number,
): Promise<{
  productGid: string;
  productId: string;
  variants: FeeVariantConfig[];
}> {
  const productCreateRes = await admin.graphql(
    `#graphql
    mutation PrintDockCreateFeeProduct($input: ProductCreateInput!) {
      productCreate(product: $input) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          title: "PrintDock Upload Fee",
          status: "ACTIVE",
          productType: "Service",
          vendor: "PrintDock",
          tags: ["printdock-fee", "system"],
          templateSuffix: "printdock-fee",
          seo: {
            title: "",
            description: "",
          },
        },
      },
    },
  );
  const createJson = await productCreateRes.json();
  const productErrors = Array.isArray(createJson?.data?.productCreate?.userErrors)
    ? createJson.data.productCreate.userErrors
    : [];
  if (productErrors.length > 0) {
    throw new Error(String(productErrors[0]?.message || "Could not create fee product"));
  }

  const productGid = String(createJson?.data?.productCreate?.product?.id || "");
  if (!productGid) throw new Error("Missing fee product id from Shopify");
  const productId = gidToNumericId(productGid);

  const denominations = buildFeeDenominationsMinorUnits(currencyDecimals);
  const variantInputs = denominations.map((amountMinorUnits) => ({
    price: toShopAmountFromMinorUnits(amountMinorUnits, currencyDecimals),
    sku: `PRINTDOCK-FEE-${toShopAmountFromMinorUnits(amountMinorUnits, currencyDecimals)}`,
    taxable: true,
    requiresShipping: false,
    inventoryPolicy: "CONTINUE",
    inventoryItem: {
      tracked: false,
    },
    optionValues: [
      {
        optionName: "Fee amount",
        name: toShopAmountFromMinorUnits(amountMinorUnits, currencyDecimals),
      },
    ],
  }));

  const variantsRes = await admin.graphql(
    `#graphql
    mutation PrintDockCreateFeeVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { productId: productGid, variants: variantInputs } },
  );
  const variantsJson = await variantsRes.json();
  const variantErrors = Array.isArray(variantsJson?.data?.productVariantsBulkCreate?.userErrors)
    ? variantsJson.data.productVariantsBulkCreate.userErrors
    : [];
  if (variantErrors.length > 0) {
    throw new Error(String(variantErrors[0]?.message || "Could not create fee variants"));
  }

  const createdVariants = Array.isArray(variantsJson?.data?.productVariantsBulkCreate?.productVariants)
    ? variantsJson.data.productVariantsBulkCreate.productVariants
    : [];
  if (createdVariants.length === 0) throw new Error("No fee variants created");

  const feeVariants: FeeVariantConfig[] = createdVariants
    .map((variant: Record<string, unknown>) => {
      const variantGid = String(variant.id || "");
      const priceRaw = Number(variant.price || 0);
      const amountMinorUnits = Math.round(priceRaw * moneyScale(currencyDecimals));
      if (!variantGid || !Number.isFinite(amountMinorUnits) || amountMinorUnits <= 0) return null;
      return {
        variantGid,
        variantId: gidToNumericId(variantGid),
        amountMinorUnits,
      };
    })
    .filter((entry: FeeVariantConfig | null): entry is FeeVariantConfig => Boolean(entry))
    .sort((a: FeeVariantConfig, b: FeeVariantConfig) => b.amountMinorUnits - a.amountMinorUnits);
  if (feeVariants.length === 0) throw new Error("Fee variants could not be parsed");

  return { productGid, productId, variants: feeVariants };
}

export async function getStoredFeeProductConfig(shopDomain: string): Promise<FeeProductConfig | null> {
  const doc = await feeProductDocRef(shopDomain).get();
  if (!doc.exists) return null;
  return normalizeFeeProductConfig(doc.data() as Record<string, unknown>);
}

export async function saveFeeProductConfig(shopDomain: string, config: FeeProductConfig): Promise<void> {
  await feeProductDocRef(shopDomain).set(config, { merge: true });
}

export async function ensureFeeProductForShop(shopDomain: string): Promise<FeeProductConfig> {
  const existing = await getStoredFeeProductConfig(shopDomain);
  if (existing) return existing;

  const { admin } = await unauthenticated.admin(shopDomain);
  const { currencyCode, currencyDecimals } = await fetchShopCurrency(admin as AdminLike);
  const created = await createFeeProduct(admin as AdminLike, currencyCode, currencyDecimals);
  const now = new Date().toISOString();
  const config: FeeProductConfig = {
    productGid: created.productGid,
    productId: created.productId,
    currencyCode,
    currencyDecimals,
    variants: created.variants,
    createdAt: now,
    updatedAt: now,
  };
  await saveFeeProductConfig(shopDomain, config);
  return config;
}

export async function archiveFeeProductForShop(shopDomain: string): Promise<void> {
  const config = await getStoredFeeProductConfig(shopDomain);
  if (!config) return;
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await (admin as AdminLike).graphql(
      `#graphql
      mutation PrintDockArchiveFeeProduct($input: ProductInput!) {
        productUpdate(product: $input) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: config.productGid,
            status: "ARCHIVED",
          },
        },
      },
    );
    const json = await response.json();
    const errors = Array.isArray(json?.data?.productUpdate?.userErrors)
      ? json.data.productUpdate.userErrors
      : [];
    if (errors.length > 0) {
      log.warn("fee_product_archive_failed", String(errors[0]?.message || "unknown"), {
        shopDomain,
      });
    }
  } catch (error) {
    log.warn("fee_product_archive_failed", String(error), { shopDomain });
  }
}

export async function clearStoredFeeProductConfig(shopDomain: string): Promise<void> {
  await feeProductDocRef(shopDomain).delete();
}
