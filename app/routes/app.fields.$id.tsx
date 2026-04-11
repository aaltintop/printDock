import crypto from "crypto";
import { data, Form, redirect, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { getEffectiveBillingPlan, getUploadField, saveUploadField } from "../services/shop-data.server";
import type { UploadFieldConfig } from "../types/printdock";

type ProductOption = {
  id: string;
  gid: string;
  title: string;
  handle: string;
  variants: Array<{ id: string; title: string }>;
};

function extractNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function emptyFieldConfig(fieldId = "new"): UploadFieldConfig {
  const nowIso = new Date().toISOString();
  return {
    id: fieldId,
    productId: "",
    productHandle: "",
    targetVariantIds: [],
    isActive: true,
    isRequired: true,
    adminTitle: "Artwork Upload Field",
    storefrontTitle: "Upload your artwork",
    storefrontDescription: "Supported files: PNG, JPG, PDF",
    fileRenamingPattern: "{orderId}_{lineItemId}_{originalName}",
    minFiles: 1,
    maxFiles: 1,
    allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
    maxFileMB: 50,
    fileQuantityManagement: {
      enabled: false,
      mode: "product_quantity",
    },
    pricing: {
      enabled: false,
      unitType: "flat",
      unitPrice: 0,
      minPrice: 0,
      dpi: 300,
      printWidth: 22,
      roundingEnabled: true,
    },
    dimensionRules: [],
    planRequirement: "free",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

async function loadProducts(admin: any): Promise<ProductOption[]> {
  const response = await admin.graphql(`
    #graphql
    query UploadFieldProducts {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  `);
  const json = await response.json();
  const edges = json?.data?.products?.edges ?? [];

  return edges.map((edge: any) => {
    const product = edge.node;
    return {
      id: extractNumericId(String(product.id)),
      gid: String(product.id),
      title: String(product.title),
      handle: String(product.handle ?? ""),
      variants: (product.variants?.edges ?? []).map((variantEdge: any) => ({
        id: extractNumericId(String(variantEdge.node.id)),
        title: String(variantEdge.node.title ?? "Default"),
      })),
    };
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id || "new";
  const products = await loadProducts(admin);
  const billingPlan = await getEffectiveBillingPlan(session.shop);

  let field = emptyFieldConfig(id);
  if (id !== "new") {
    const existing = await getUploadField(session.shop, id);
    if (!existing) {
      throw data({ error: "Field not found" }, { status: 404 });
    }
    field = existing;
  }

  return data({
    field,
    isNew: id === "new",
    products,
    shopDomain: session.shop,
    billingPlan,
  });
};

function parseNumber(value: FormDataEntryValue | null, fallback: number): number {
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = params.id || "new";
  const nowIso = new Date().toISOString();
  const billingPlan = await getEffectiveBillingPlan(session.shop);

  const productId = String(formData.get("productId") || "").trim();
  if (!productId) {
    return data({ error: "Product is required" }, { status: 400 });
  }

  const productGid = `gid://shopify/Product/${productId}`;
  const productResponse = await admin.graphql(
    `
      #graphql
      query SelectedProduct($id: ID!) {
        product(id: $id) {
          id
          handle
          variants(first: 100) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `,
    { variables: { id: productGid } },
  );
  const productJson = await productResponse.json();
  const product = productJson?.data?.product;
  if (!product) {
    return data({ error: "Selected product is invalid" }, { status: 400 });
  }

  const allowedVariantIds = new Set<string>(
    (product.variants?.edges ?? []).map((edge: any) => extractNumericId(String(edge.node.id))),
  );
  const targetVariantIds = formData
    .getAll("targetVariantIds")
    .map((value) => String(value))
    .filter((value) => allowedVariantIds.has(value));

  const allowedExtensions = String(formData.get("allowedExtensions") || "")
    .split(",")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);

  const dimensionRulesRaw = String(formData.get("dimensionRules") || "[]").trim();
  let dimensionRules: UploadFieldConfig["dimensionRules"] = [];
  try {
    const parsedRules = JSON.parse(dimensionRulesRaw);
    if (Array.isArray(parsedRules)) {
      dimensionRules = parsedRules;
    }
  } catch (error) {
    return data({ error: "Dimension rules must be valid JSON array" }, { status: 400 });
  }

  const existingField = id !== "new" ? await getUploadField(session.shop, id) : null;
  const fieldId = id === "new" ? crypto.randomUUID() : id;
  const pricingEnabled = parseBoolean(formData.get("pricingEnabled"));
  const maxFileMB = Math.max(1, parseNumber(formData.get("maxFileMB"), 50));

  if (pricingEnabled && !billingPlan.allowAutoPricing) {
    return data({ error: "Auto pricing requires a higher plan." }, { status: 402 });
  }
  if (dimensionRules.length > 0 && !billingPlan.allowAdvancedRules) {
    return data({ error: "Advanced dimension rules require a higher plan." }, { status: 402 });
  }
  if (maxFileMB > billingPlan.maxFileMBLimit) {
    return data(
      { error: `Your current plan supports up to ${billingPlan.maxFileMBLimit}MB per file.` },
      { status: 402 },
    );
  }

  const nextField: UploadFieldConfig = {
    id: fieldId,
    productId,
    productHandle: String(product.handle ?? ""),
    targetVariantIds,
    isActive: parseBoolean(formData.get("isActive")),
    isRequired: parseBoolean(formData.get("isRequired")),
    adminTitle: String(formData.get("adminTitle") || "Upload Field"),
    storefrontTitle: String(formData.get("storefrontTitle") || "Upload your file"),
    storefrontDescription: String(formData.get("storefrontDescription") || ""),
    fileRenamingPattern: String(formData.get("fileRenamingPattern") || "{orderId}_{originalName}"),
    minFiles: 1,
    maxFiles: 1,
    allowedExtensions: allowedExtensions.length > 0 ? allowedExtensions : ["png", "jpg", "jpeg", "pdf"],
    maxFileMB,
    fileQuantityManagement: {
      enabled: parseBoolean(formData.get("fileQuantityEnabled")),
      mode:
        String(formData.get("quantityMode")) === "per_file" ? "per_file" : "product_quantity",
    },
    pricing: {
      enabled: pricingEnabled,
      unitType:
        String(formData.get("pricingUnitType")) === "inch_height" ||
        String(formData.get("pricingUnitType")) === "inch_square" ||
        String(formData.get("pricingUnitType")) === "per_file"
          ? (String(formData.get("pricingUnitType")) as "inch_height" | "inch_square" | "per_file")
          : "flat",
      unitPrice: parseNumber(formData.get("unitPrice"), 0),
      minPrice: parseNumber(formData.get("minPrice"), 0),
      dpi: parseNumber(formData.get("dpi"), 300),
      printWidth: parseNumber(formData.get("printWidth"), 22),
      roundingEnabled: parseBoolean(formData.get("roundingEnabled")),
    },
    dimensionRules,
    planRequirement:
      String(formData.get("planRequirement")) === "basic_plus" ||
      String(formData.get("planRequirement")) === "pro_plus"
        ? (String(formData.get("planRequirement")) as "basic_plus" | "pro_plus")
        : "free",
    createdAt: existingField?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  await saveUploadField(session.shop, nextField);
  return redirect(`/app/fields?saved=1`);
};

export default function FieldEditorPage() {
  const { field, products, isNew, shopDomain, billingPlan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const initialProductId = field.productId || products[0]?.id || "";
  const [selectedProductId, setSelectedProductId] = useState(initialProductId);
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>(field.targetVariantIds);

  const selectedProduct = useMemo(() => {
    return products.find((product) => product.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  return (
    <s-page heading={isNew ? "Create Upload Field" : "Edit Upload Field"}>
      <Form method="post">
        <s-stack direction="block" gap="base">
          {actionData && "error" in actionData ? (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-text>{actionData.error}</s-text>
            </s-box>
          ) : null}

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Plan Limits</s-heading>
            <s-paragraph>
              Active plan: {billingPlan.planCode}. Max file size: {billingPlan.maxFileMBLimit}MB. Advanced rules: {billingPlan.allowAdvancedRules ? "enabled" : "locked"}. Auto pricing: {billingPlan.allowAutoPricing ? "enabled" : "locked"}.
            </s-paragraph>
            {!billingPlan.allowAdvancedRules || !billingPlan.allowAutoPricing ? (
              <s-button href="/app/plans">Upgrade Plan</s-button>
            ) : null}
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Field Basics</s-heading>
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              <label>
                Admin title
                <input type="text" name="adminTitle" defaultValue={field.adminTitle} required />
              </label>
              <label>
                Product
                <select
                  name="productId"
                  value={selectedProductId}
                  onChange={(event) => setSelectedProductId(event.target.value)}
                  required
                >
                  <option value="">Select a product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target variants
                <select
                  name="targetVariantIds"
                  multiple
                  size={8}
                  value={selectedVariantIds}
                  onChange={(event) => {
                    const values = Array.from(event.target.selectedOptions).map((option) => option.value);
                    setSelectedVariantIds(values);
                  }}
                >
                  {(selectedProduct?.variants ?? []).map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" name="isActive" defaultChecked={field.isActive} /> Active
              </label>
              <label>
                <input type="checkbox" name="isRequired" defaultChecked={field.isRequired} /> Required before add-to-cart
              </label>
            </div>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Storefront Content</s-heading>
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              <label>
                Storefront title
                <input type="text" name="storefrontTitle" defaultValue={field.storefrontTitle} />
              </label>
              <label>
                Storefront description
                <textarea name="storefrontDescription" rows={3} defaultValue={field.storefrontDescription} />
              </label>
              <label>
                File renaming pattern
                <input
                  type="text"
                  name="fileRenamingPattern"
                  defaultValue={field.fileRenamingPattern}
                />
              </label>
            </div>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>File Rules</s-heading>
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              <label>
                Allowed extensions (comma-separated)
                <input
                  type="text"
                  name="allowedExtensions"
                  defaultValue={field.allowedExtensions.join(",")}
                />
              </label>
              <s-paragraph>Single-file upload mode. Each customer uploads exactly one file per product.</s-paragraph>
              <label>
                Max file MB
                <input type="number" min={1} name="maxFileMB" defaultValue={field.maxFileMB} />
              </label>
              <label>
                <input
                  type="checkbox"
                  name="fileQuantityEnabled"
                  defaultChecked={field.fileQuantityManagement.enabled}
                />
                Enable custom quantity management
              </label>
              <label>
                Quantity mode
                <select name="quantityMode" defaultValue={field.fileQuantityManagement.mode}>
                  <option value="product_quantity">Use Shopify product quantity</option>
                  <option value="per_file">Per-file quantity controls</option>
                </select>
              </label>
            </div>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Pricing</s-heading>
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              <label>
                <input type="checkbox" name="pricingEnabled" defaultChecked={field.pricing.enabled} />
                Enable dynamic pricing
              </label>
              <label>
                Unit type
                <select name="pricingUnitType" defaultValue={field.pricing.unitType}>
                  <option value="flat">Flat</option>
                  <option value="per_file">Per file</option>
                  <option value="inch_height">Per inch height</option>
                  <option value="inch_square">Per square inch</option>
                </select>
              </label>
              <label>
                Unit price
                <input type="number" step="0.01" name="unitPrice" defaultValue={field.pricing.unitPrice} />
              </label>
              <label>
                Minimum price
                <input type="number" step="0.01" name="minPrice" defaultValue={field.pricing.minPrice} />
              </label>
              <label>
                Target DPI
                <input type="number" name="dpi" defaultValue={field.pricing.dpi} />
              </label>
              <label>
                Print width (inch)
                <input type="number" step="0.1" name="printWidth" defaultValue={field.pricing.printWidth} />
              </label>
              <label>
                <input type="checkbox" name="roundingEnabled" defaultChecked={field.pricing.roundingEnabled} />
                Enable rounding
              </label>
            </div>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Dimension Rules</s-heading>
            <s-paragraph>
              Enter JSON array. Each rule should include: id, dimensionType, operator, value, action, warningMessage.
            </s-paragraph>
            <textarea
              name="dimensionRules"
              rows={10}
              defaultValue={JSON.stringify(field.dimensionRules, null, 2)}
              style={{ width: "100%", marginTop: 12 }}
            />
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-heading>Plan Requirement</s-heading>
            <label>
              Required plan
              <select name="planRequirement" defaultValue={field.planRequirement}>
                <option value="free">Free</option>
                <option value="basic_plus">Basic Plus</option>
                <option value="pro_plus">Pro Plus</option>
              </select>
            </label>
          </s-box>

          <s-stack direction="inline" gap="base">
            <button type="submit" style={{ padding: "8px 20px", fontWeight: 600, cursor: "pointer" }}>
              Save Field
            </button>
            <s-button href="/app/fields">Back to Fields</s-button>
            {field.productHandle ? (
              <s-button href={`https://${shopDomain}/products/${field.productHandle}`} target="_blank">
                Preview Product
              </s-button>
            ) : null}
          </s-stack>
        </s-stack>
      </Form>
    </s-page>
  );
}

