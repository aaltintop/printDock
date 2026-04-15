import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  ContextualSaveBar,
  FormLayout,
  InlineStack,
  Page,
  Popover,
  Select,
  SkeletonBodyText,
  SkeletonPage,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getEffectiveBillingPlan, getUploadField, saveUploadField } from "../services/shop-data.server";
import type { UploadFieldConfig, UploadFieldDimensionRule } from "../types/printdock";

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
  return redirect(`/app/fields?toast=field_saved`);
};

export default function FieldEditorPage() {
  const { field, products, isNew, shopDomain, billingPlan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const appBridge = useAppBridge();
  const [searchParams] = useSearchParams();

  const initialState = useMemo(
    () => ({
      adminTitle: field.adminTitle,
      productId: field.productId || "",
      targetVariantIds: field.targetVariantIds,
      isActive: field.isActive,
      isRequired: field.isRequired,
      storefrontTitle: field.storefrontTitle,
      storefrontDescription: field.storefrontDescription,
      fileRenamingPattern: field.fileRenamingPattern,
      allowedExtensions: field.allowedExtensions,
      maxFileMB: String(field.maxFileMB),
      fileQuantityEnabled: field.fileQuantityManagement.enabled,
      quantityMode: field.fileQuantityManagement.mode,
      pricingEnabled: field.pricing.enabled,
      pricingUnitType: field.pricing.unitType,
      unitPrice: String(field.pricing.unitPrice),
      minPrice: String(field.pricing.minPrice),
      dpi: String(field.pricing.dpi),
      printWidth: String(field.pricing.printWidth),
      roundingEnabled: field.pricing.roundingEnabled,
      planRequirement: field.planRequirement,
      dimensionRules: field.dimensionRules,
    }),
    [field],
  );

  const [adminTitle, setAdminTitle] = useState(initialState.adminTitle);
  const [selectedProductId, setSelectedProductId] = useState(initialState.productId);
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>(initialState.targetVariantIds);
  const [isActive, setIsActive] = useState(initialState.isActive);
  const [isRequired, setIsRequired] = useState(initialState.isRequired);
  const [storefrontTitle, setStorefrontTitle] = useState(initialState.storefrontTitle);
  const [storefrontDescription, setStorefrontDescription] = useState(initialState.storefrontDescription);
  const [fileRenamingPattern, setFileRenamingPattern] = useState(initialState.fileRenamingPattern);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>(initialState.allowedExtensions);
  const [newExtension, setNewExtension] = useState("");
  const [maxFileMB, setMaxFileMB] = useState(initialState.maxFileMB);
  const [fileQuantityEnabled, setFileQuantityEnabled] = useState(initialState.fileQuantityEnabled);
  const [quantityMode, setQuantityMode] = useState(initialState.quantityMode);
  const [pricingEnabled, setPricingEnabled] = useState(initialState.pricingEnabled);
  const [pricingUnitType, setPricingUnitType] = useState(initialState.pricingUnitType);
  const [unitPrice, setUnitPrice] = useState(initialState.unitPrice);
  const [minPrice, setMinPrice] = useState(initialState.minPrice);
  const [dpi, setDpi] = useState(initialState.dpi);
  const [printWidth, setPrintWidth] = useState(initialState.printWidth);
  const [roundingEnabled, setRoundingEnabled] = useState(initialState.roundingEnabled);
  const [planRequirement, setPlanRequirement] = useState(initialState.planRequirement);
  const [renameHelpOpen, setRenameHelpOpen] = useState(false);
  const [dimensionRules, setDimensionRules] = useState<UploadFieldDimensionRule[]>(
    initialState.dimensionRules.length > 0
      ? initialState.dimensionRules
      : [
          {
            id: crypto.randomUUID(),
            dimensionType: "widthInch",
            operator: "lte",
            value: 1,
            action: "prevent",
            warningMessage: "",
          },
        ],
  );

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  const serializedCurrent = JSON.stringify({
    adminTitle,
    selectedProductId,
    selectedVariantIds,
    isActive,
    isRequired,
    storefrontTitle,
    storefrontDescription,
    fileRenamingPattern,
    allowedExtensions,
    maxFileMB,
    fileQuantityEnabled,
    quantityMode,
    pricingEnabled,
    pricingUnitType,
    unitPrice,
    minPrice,
    dpi,
    printWidth,
    roundingEnabled,
    planRequirement,
    dimensionRules,
  });
  const serializedInitial = JSON.stringify({
    ...initialState,
    selectedProductId: initialState.productId,
  });
  const isDirty = serializedCurrent !== serializedInitial;

  const resetForm = () => {
    setAdminTitle(initialState.adminTitle);
    setSelectedProductId(initialState.productId);
    setSelectedVariantIds(initialState.targetVariantIds);
    setIsActive(initialState.isActive);
    setIsRequired(initialState.isRequired);
    setStorefrontTitle(initialState.storefrontTitle);
    setStorefrontDescription(initialState.storefrontDescription);
    setFileRenamingPattern(initialState.fileRenamingPattern);
    setAllowedExtensions(initialState.allowedExtensions);
    setMaxFileMB(initialState.maxFileMB);
    setFileQuantityEnabled(initialState.fileQuantityEnabled);
    setQuantityMode(initialState.quantityMode);
    setPricingEnabled(initialState.pricingEnabled);
    setPricingUnitType(initialState.pricingUnitType);
    setUnitPrice(initialState.unitPrice);
    setMinPrice(initialState.minPrice);
    setDpi(initialState.dpi);
    setPrintWidth(initialState.printWidth);
    setRoundingEnabled(initialState.roundingEnabled);
    setPlanRequirement(initialState.planRequirement);
    setDimensionRules(initialState.dimensionRules);
  };

  const openResourcePicker = async () => {
    const selection = await (appBridge as any).resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
      filter: { variants: false },
    });
    const selected = selection?.[0]?.id;
    if (typeof selected === "string") {
      setSelectedProductId(extractNumericId(selected));
      setSelectedVariantIds([]);
    }
  };

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      appBridge.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, appBridge]);

  useEffect(() => {
    if (searchParams.get("toast") === "duplicated") {
      appBridge.toast.show("Field duplicated");
    }
  }, [appBridge, searchParams]);

  if (navigation.state === "loading") {
    return (
      <Page title={isNew ? "Create Upload Field" : "Edit Upload Field"}>
        <SkeletonPage primaryAction>
          <Card>
            <SkeletonBodyText lines={10} />
          </Card>
        </SkeletonPage>
      </Page>
    );
  }

  return (
    <Page
      title={isNew ? "Create Upload Field" : "Edit Upload Field"}
      backAction={{ content: "Fields", url: "/app/fields" }}
    >
      {isDirty ? (
        <ContextualSaveBar
          message="Unsaved changes"
          saveAction={{
            onAction: () => {
              const form = document.getElementById("field-editor-form") as HTMLFormElement | null;
              form?.requestSubmit();
            },
          }}
          discardAction={{ onAction: resetForm }}
        />
      ) : null}
      <Form method="post" id="field-editor-form">
        <input type="hidden" name="productId" value={selectedProductId} />
        {selectedVariantIds.map((variantId) => (
          <input key={variantId} type="hidden" name="targetVariantIds" value={variantId} />
        ))}
        <input type="hidden" name="allowedExtensions" value={allowedExtensions.join(",")} />
        <input type="hidden" name="dimensionRules" value={JSON.stringify(dimensionRules)} />

        <BlockStack gap="400">
          {!billingPlan.allowAdvancedRules || !billingPlan.allowAutoPricing ? (
            <Banner
              tone="warning"
              title="Upgrade your plan to unlock advanced rules and auto pricing."
              action={{ content: "Upgrade plan", url: "/app/plans" }}
            />
          ) : null}

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Field Basics
              </Text>
              <FormLayout>
                <TextField
                  name="adminTitle"
                  label="Admin title"
                  value={adminTitle}
                  autoComplete="off"
                  onChange={setAdminTitle}
                  requiredIndicator
                />
                <InlineStack align="start">
                  <Button onClick={openResourcePicker}>Select product</Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {selectedProduct ? `Selected: ${selectedProduct.title}` : "No product selected"}
                </Text>
                {selectedProduct ? (
                  <ChoiceList
                    title="Target variants"
                    allowMultiple
                    selected={selectedVariantIds}
                    choices={selectedProduct.variants.map((variant) => ({
                      label: variant.title,
                      value: variant.id,
                    }))}
                    onChange={(values) => setSelectedVariantIds(values)}
                  />
                ) : null}
                <Checkbox label="Active" name="isActive" checked={isActive} onChange={setIsActive} />
                <Checkbox
                  label="Required before add-to-cart"
                  name="isRequired"
                  checked={isRequired}
                  onChange={setIsRequired}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Storefront Content
              </Text>
              <FormLayout>
                <TextField
                  label="Storefront title"
                  name="storefrontTitle"
                  value={storefrontTitle}
                  autoComplete="off"
                  onChange={setStorefrontTitle}
                />
                <TextField
                  label="Description"
                  name="storefrontDescription"
                  multiline={3}
                  autoComplete="off"
                  value={storefrontDescription}
                  onChange={setStorefrontDescription}
                />
                <TextField
                  label="File rename pattern"
                  name="fileRenamingPattern"
                  autoComplete="off"
                  value={fileRenamingPattern}
                  onChange={setFileRenamingPattern}
                  connectedRight={
                    <Popover
                      active={renameHelpOpen}
                      onClose={() => setRenameHelpOpen(false)}
                      activator={<Button onClick={() => setRenameHelpOpen(true)}>Tokens</Button>}
                    >
                      <Card>
                        <BlockStack gap="100">
                          <Text as="p">{`{orderId}`}</Text>
                          <Text as="p">{`{lineItem}`}</Text>
                          <Text as="p">{`{fileName}`}</Text>
                          <Text as="p">{`{timestamp}`}</Text>
                        </BlockStack>
                      </Card>
                    </Popover>
                  }
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                File Rules
              </Text>
              <InlineStack gap="200" wrap>
                {allowedExtensions.map((ext) => (
                  <Tag key={ext} onRemove={() => setAllowedExtensions((prev) => prev.filter((item) => item !== ext))}>
                    {ext}
                  </Tag>
                ))}
              </InlineStack>
              <InlineStack gap="200" blockAlign="end">
                <div style={{ minWidth: 180 }}>
                  <TextField
                    label="Add extension"
                    value={newExtension}
                    autoComplete="off"
                    onChange={setNewExtension}
                  />
                </div>
                <Button
                  onClick={() => {
                    const normalized = newExtension.trim().toLowerCase();
                    if (normalized && !allowedExtensions.includes(normalized)) {
                      setAllowedExtensions((prev) => [...prev, normalized]);
                    }
                    setNewExtension("");
                  }}
                >
                  Add
                </Button>
              </InlineStack>
              <FormLayout>
                <TextField
                  name="maxFileMB"
                  label="Max file size"
                  type="number"
                  suffix="MB"
                  autoComplete="off"
                  value={maxFileMB}
                  onChange={setMaxFileMB}
                />
                <Checkbox
                  name="fileQuantityEnabled"
                  label="Enable custom quantity management"
                  checked={fileQuantityEnabled}
                  onChange={setFileQuantityEnabled}
                />
                <Select
                  name="quantityMode"
                  label="Quantity mode"
                  value={quantityMode}
                  options={[
                    { label: "Use Shopify product quantity", value: "product_quantity" },
                    { label: "Per-file quantity controls", value: "per_file" },
                  ]}
                  onChange={(value) => setQuantityMode(value as "product_quantity" | "per_file")}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Pricing
              </Text>
              <FormLayout>
                <Checkbox
                  name="pricingEnabled"
                  label="Enable dynamic pricing"
                  checked={pricingEnabled}
                  onChange={setPricingEnabled}
                />
                <Select
                  name="pricingUnitType"
                  label="Unit type"
                  value={pricingUnitType}
                  options={[
                    { label: "Flat", value: "flat" },
                    { label: "Per file", value: "per_file" },
                    { label: "Per inch height", value: "inch_height" },
                    { label: "Per square inch", value: "inch_square" },
                  ]}
                  onChange={(value) => setPricingUnitType(value as UploadFieldConfig["pricing"]["unitType"])}
                  disabled={!pricingEnabled}
                />
                <TextField
                  name="unitPrice"
                  label="Unit price"
                  type="number"
                  prefix="$"
                  autoComplete="off"
                  value={unitPrice}
                  onChange={setUnitPrice}
                  disabled={!pricingEnabled}
                />
                <TextField
                  name="minPrice"
                  label="Minimum price"
                  type="number"
                  prefix="$"
                  autoComplete="off"
                  value={minPrice}
                  onChange={setMinPrice}
                  disabled={!pricingEnabled}
                />
                <TextField
                  name="dpi"
                  label="Target DPI"
                  type="number"
                  suffix="DPI"
                  helpText="Used to calculate physical print dimensions from pixel size."
                  autoComplete="off"
                  value={dpi}
                  onChange={setDpi}
                  disabled={!pricingEnabled}
                />
                <TextField
                  name="printWidth"
                  label="Print width"
                  type="number"
                  suffix="inch"
                  autoComplete="off"
                  value={printWidth}
                  onChange={setPrintWidth}
                  disabled={!pricingEnabled}
                />
                <Checkbox
                  name="roundingEnabled"
                  label="Enable rounding"
                  checked={roundingEnabled}
                  onChange={setRoundingEnabled}
                  disabled={!pricingEnabled}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Dimension Rules
              </Text>
              {dimensionRules.map((rule, index) => (
                <InlineStack key={rule.id} gap="200" blockAlign="end" wrap>
                  <div style={{ minWidth: 180 }}>
                    <Select
                      label="Dimension"
                      value={rule.dimensionType}
                      options={[
                        { label: "Width", value: "widthInch" },
                        { label: "Height", value: "heightInch" },
                        { label: "DPI", value: "dpi" },
                      ]}
                      onChange={(value) =>
                        setDimensionRules((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, dimensionType: value as any } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div style={{ minWidth: 160 }}>
                    <Select
                      label="Rule"
                      value={rule.operator}
                      options={[
                        { label: "Min (>=)", value: "gte" },
                        { label: "Max (<=)", value: "lte" },
                        { label: "Equals", value: "eq" },
                      ]}
                      onChange={(value) =>
                        setDimensionRules((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, operator: value as any } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div style={{ minWidth: 120 }}>
                    <TextField
                      label="Value"
                      type="number"
                      autoComplete="off"
                      value={String(rule.value)}
                      onChange={(value) =>
                        setDimensionRules((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, value: Number(value) } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    tone="critical"
                    onClick={() =>
                      setDimensionRules((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    Remove
                  </Button>
                </InlineStack>
              ))}
              <Button
                onClick={() =>
                  setDimensionRules((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      dimensionType: "widthInch",
                      operator: "gte",
                      value: 1,
                      action: "prevent",
                      warningMessage: "",
                    },
                  ])
                }
              >
                Add Rule
              </Button>
            </BlockStack>
          </Card>

          <Card>
            <FormLayout>
              <Select
                name="planRequirement"
                label="Required plan"
                value={planRequirement}
                options={[
                  { label: "Free", value: "free" },
                  { label: "Basic Plus", value: "basic_plus" },
                  { label: "Pro Plus", value: "pro_plus" },
                ]}
                onChange={(value) => setPlanRequirement(value as UploadFieldConfig["planRequirement"])}
              />
            </FormLayout>
          </Card>

          <InlineStack gap="200">
            <Button submit variant="primary">
              Save Field
            </Button>
            <Button url="/app/fields">Back to Fields</Button>
            {field.productHandle ? (
              <Button url={`https://${shopDomain}/products/${field.productHandle}`} target="_blank">
                Preview Product
              </Button>
            ) : null}
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}

