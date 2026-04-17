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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ContextualSaveBar,
  Divider,
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
import { canUseFeature, getPlan, isWithinFieldLimit } from "../config/plans";
import { getEffectiveBillingPlan, getUploadField, listUploadFields, saveUploadField } from "../services/shop-data.server";
import type {
  FieldDimensionType,
  FieldOperator,
  FieldTargetCollection,
  FieldTargetProduct,
  UploadFieldConfig,
  UploadFieldDimensionRule,
} from "../types/printdock";

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
    targetProducts: [],
    targetCollections: [],
    targetProductIds: [],
    targetCollectionIds: [],
    isActive: true,
    isRequired: true,
    adminTitle: "Artwork Field",
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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id || "new";

  let field = emptyFieldConfig(id);
  if (id !== "new") {
    const existing = await getUploadField(session.shop, id);
    if (!existing) {
      throw data({ error: "Field not found" }, { status: 404 });
    }
    field = existing;
  }

  const billingPlan = await getEffectiveBillingPlan(session.shop);
  const planLimits = getPlan(billingPlan.planCode);
  const maxFileMBFromPlan = Math.floor(planLimits.maxFileSizeBytes / (1024 * 1024));

  let fieldCreationBlocked = false;
  if (id === "new") {
    const allFields = await listUploadFields(session.shop);
    fieldCreationBlocked = !isWithinFieldLimit(billingPlan.planCode, allFields.length);
  }

  return data({
    field,
    isNew: id === "new",
    shopDomain: session.shop,
    planCode: billingPlan.planCode,
    maxFileMBFromPlan,
    fieldCreationBlocked,
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

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = params.id || "new";
  const nowIso = new Date().toISOString();
  const billingPlan = await getEffectiveBillingPlan(session.shop);

  const targetProducts: FieldTargetProduct[] = parseJsonArray(
    String(formData.get("targetProducts") || "[]"),
    [],
  );
  const targetCollections: FieldTargetCollection[] = parseJsonArray(
    String(formData.get("targetCollections") || "[]"),
    [],
  );

  if (targetProducts.length === 0 && targetCollections.length === 0) {
    return data({ error: "Select at least one product or collection" }, { status: 400 });
  }

  const targetProductIds = targetProducts.map((p) => p.id).filter(Boolean);
  const targetCollectionIds = targetCollections.map((c) => c.id).filter(Boolean);

  const targetVariantIds = parseJsonArray<string>(
    String(formData.get("targetVariantIds") || "[]"),
    [],
  );

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
  } catch {
    return data({ error: "Dimension rules must be valid JSON array" }, { status: 400 });
  }

  const existingField = id !== "new" ? await getUploadField(session.shop, id) : null;
  const fieldId = id === "new" ? crypto.randomUUID() : id;
  const pricingEnabled = parseBoolean(formData.get("pricingEnabled"));
  const maxFileMB = Math.max(1, parseNumber(formData.get("maxFileMB"), 50));

  const planCode = billingPlan.planCode;
  const planLimits = getPlan(planCode);
  const maxFileMBFromPlan = Math.floor(planLimits.maxFileSizeBytes / (1024 * 1024));

  if (!canUseFeature(planCode, "advancedValidation")) {
    dimensionRules = [];
  }

  if (id === "new") {
    const allFields = await listUploadFields(session.shop);
    if (!isWithinFieldLimit(planCode, allFields.length)) {
      return data({ error: "Upgrade your plan to add more fields." }, { status: 402 });
    }
  }

  if (pricingEnabled && !canUseFeature(planCode, "dynamicPricing")) {
    return data({ error: "Dynamic pricing requires a higher plan." }, { status: 402 });
  }
  if (maxFileMB > maxFileMBFromPlan) {
    return data(
      { error: `Your current plan supports up to ${maxFileMBFromPlan}MB per file.` },
      { status: 402 },
    );
  }

  const firstProduct = targetProducts[0];

  const nextField: UploadFieldConfig = {
    id: fieldId,
    productId: firstProduct?.id ?? "",
    productHandle: firstProduct?.handle ?? "",
    targetVariantIds,
    targetProducts,
    targetCollections,
    targetProductIds,
    targetCollectionIds,
    isActive: parseBoolean(formData.get("isActive")),
    isRequired: true,
    adminTitle: String(formData.get("adminTitle") || "Field"),
    storefrontTitle: String(formData.get("storefrontTitle") || "Upload your file"),
    storefrontDescription: String(formData.get("storefrontDescription") || ""),
    fileRenamingPattern: String(formData.get("fileRenamingPattern") || "{orderId}_{originalName}"),
    minFiles: 1,
    maxFiles: 1,
    allowedExtensions,
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
    planRequirement: "free",
    createdAt: existingField?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  await saveUploadField(session.shop, nextField);
  return redirect(`/app/fields?toast=field_saved`);
};

export default function FieldEditorPage() {
  const { field, isNew, shopDomain, planCode, maxFileMBFromPlan, fieldCreationBlocked } =
    useLoaderData<typeof loader>();
  const planAllowsDynamicPricing = canUseFeature(planCode, "dynamicPricing");
  const planAllowsAdvancedValidation = canUseFeature(planCode, "advancedValidation");
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const appBridge = useAppBridge();
  const [searchParams] = useSearchParams();

  const initialState = useMemo(
    () => ({
      adminTitle: field.adminTitle,
      targetProducts: field.targetProducts,
      targetCollections: field.targetCollections,
      targetVariantIds: field.targetVariantIds,
      isActive: field.isActive,
      storefrontTitle: field.storefrontTitle,
      storefrontDescription: field.storefrontDescription,
      fileRenamingPattern: field.fileRenamingPattern,
      allowedExtensions: field.allowedExtensions,
      maxFileMB: String(field.maxFileMB),
      fileQuantityEnabled: field.fileQuantityManagement.enabled,
      quantityMode: field.fileQuantityManagement.mode,
      pricingEnabled: canUseFeature(planCode, "dynamicPricing") && field.pricing.enabled,
      pricingUnitType: field.pricing.unitType,
      unitPrice: String(field.pricing.unitPrice),
      minPrice: String(field.pricing.minPrice),
      dpi: String(field.pricing.dpi),
      printWidth: String(field.pricing.printWidth),
      roundingEnabled: field.pricing.roundingEnabled,
      dimensionRules: (() => {
        if (!canUseFeature(planCode, "advancedValidation")) {
          return [];
        }
        if (field.dimensionRules.length > 0) {
          return field.dimensionRules;
        }
        return [
          {
            id: crypto.randomUUID(),
            dimensionType: "widthInch" as const,
            operator: "lte" as const,
            value: 1,
            action: "prevent" as const,
            warningMessage: "",
          },
        ];
      })(),
    }),
    [field, planCode],
  );

  const [adminTitle, setAdminTitle] = useState(initialState.adminTitle);
  const [targetProducts, setTargetProducts] = useState<FieldTargetProduct[]>(initialState.targetProducts);
  const [targetCollections, setTargetCollections] = useState<FieldTargetCollection[]>(initialState.targetCollections);
  const [targetVariantIds, setTargetVariantIds] = useState<string[]>(initialState.targetVariantIds);
  const [isActive, setIsActive] = useState(initialState.isActive);
  const [storefrontTitle, setStorefrontTitle] = useState(initialState.storefrontTitle);
  const [storefrontDescription, setStorefrontDescription] = useState(initialState.storefrontDescription);
  const [fileRenamingPattern, setFileRenamingPattern] = useState(initialState.fileRenamingPattern);
  const [contentTypeRestricted, setContentTypeRestricted] = useState(initialState.allowedExtensions.length > 0);
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
  const [renameHelpOpen, setRenameHelpOpen] = useState(false);
  const [dimensionRules, setDimensionRules] = useState<UploadFieldDimensionRule[]>(
    initialState.dimensionRules,
  );

  const serializedCurrent = JSON.stringify({
    adminTitle,
    targetProducts,
    targetCollections,
    targetVariantIds,
    isActive,
    storefrontTitle,
    storefrontDescription,
    fileRenamingPattern,
    contentTypeRestricted,
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
    dimensionRules,
  });
  const serializedInitial = JSON.stringify(initialState);
  const isDirty = serializedCurrent !== serializedInitial;

  const resetForm = () => {
    setAdminTitle(initialState.adminTitle);
    setTargetProducts(initialState.targetProducts);
    setTargetCollections(initialState.targetCollections);
    setTargetVariantIds(initialState.targetVariantIds);
    setIsActive(initialState.isActive);
    setStorefrontTitle(initialState.storefrontTitle);
    setStorefrontDescription(initialState.storefrontDescription);
    setFileRenamingPattern(initialState.fileRenamingPattern);
    setContentTypeRestricted(initialState.allowedExtensions.length > 0);
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
    setDimensionRules(initialState.dimensionRules);
  };

  const openProductPicker = useCallback(async () => {
    const selection = await (appBridge as any).resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      filter: { variants: false },
    });
    if (!Array.isArray(selection)) return;
    const newProducts: FieldTargetProduct[] = selection.map((item: any) => ({
      id: extractNumericId(String(item.id)),
      title: String(item.title ?? ""),
      handle: String(item.handle ?? ""),
    }));
    setTargetProducts((prev) => {
      const existingIds = new Set(prev.map((p) => p.id));
      const additions = newProducts.filter((p) => !existingIds.has(p.id));
      return [...prev, ...additions];
    });
  }, [appBridge]);

  const openCollectionPicker = useCallback(async () => {
    const selection = await (appBridge as any).resourcePicker({
      type: "collection",
      action: "select",
      multiple: true,
    });
    if (!Array.isArray(selection)) return;
    const newCollections: FieldTargetCollection[] = selection.map((item: any) => ({
      id: extractNumericId(String(item.id)),
      title: String(item.title ?? ""),
    }));
    setTargetCollections((prev) => {
      const existingIds = new Set(prev.map((c) => c.id));
      const additions = newCollections.filter((c) => !existingIds.has(c.id));
      return [...prev, ...additions];
    });
  }, [appBridge]);

  const removeProduct = useCallback((id: string) => {
    setTargetProducts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const removeCollection = useCallback((id: string) => {
    setTargetCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

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

  const pageTitle = isNew ? "Create Field" : (adminTitle || "Edit Field");
  const hasTargets = targetProducts.length > 0 || targetCollections.length > 0;
  const firstProductHandle = targetProducts[0]?.handle;

  if (navigation.state === "loading") {
    return (
      <Page title={pageTitle}>
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
      title={pageTitle}
      backAction={{ content: "Fields", url: "/app/fields" }}
    >
      {isDirty ? (
        <ContextualSaveBar
          message="Unsaved changes"
          saveAction={{
            onAction: () => {
              if (fieldCreationBlocked) return;
              const form = document.getElementById("field-editor-form") as HTMLFormElement | null;
              form?.requestSubmit();
            },
          }}
          discardAction={{ onAction: resetForm }}
        />
      ) : null}
      <Form
        method="post"
        id="field-editor-form"
        onSubmit={(event) => {
          if (fieldCreationBlocked) event.preventDefault();
        }}
      >
        <input type="hidden" name="targetProducts" value={JSON.stringify(targetProducts)} />
        <input type="hidden" name="targetCollections" value={JSON.stringify(targetCollections)} />
        <input type="hidden" name="targetVariantIds" value={JSON.stringify(targetVariantIds)} />
        <input type="hidden" name="allowedExtensions" value={contentTypeRestricted ? allowedExtensions.join(",") : ""} />
        <input type="hidden" name="dimensionRules" value={JSON.stringify(dimensionRules)} />

        <BlockStack gap="400">
          {fieldCreationBlocked ? (
            <Banner
              tone="warning"
              title="Field limit reached"
              action={{ content: "View plans", url: "/app/plans" }}
            >
              Upgrade your plan to add more fields.
            </Banner>
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
                  helpText="Only visible to you in the admin. Customers never see this."
                  value={adminTitle}
                  autoComplete="off"
                  onChange={setAdminTitle}
                  requiredIndicator
                />
                <Checkbox label="Active" name="isActive" checked={isActive} onChange={setIsActive} />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Display Target
              </Text>
              <Text as="p" tone="subdued">
                Choose where this field appears on your storefront. Products and collections
                are combined — the field shows on any product that is directly selected or belongs
                to a selected collection.
              </Text>

              <Divider />

              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Products
                  </Text>
                  <Button onClick={openProductPicker}>Browse products</Button>
                </InlineStack>
                {targetProducts.length > 0 ? (
                  <InlineStack gap="200" wrap>
                    {targetProducts.map((product) => (
                      <Tag key={product.id} onRemove={() => removeProduct(product.id)}>
                        {product.title || `Product ${product.id}`}
                      </Tag>
                    ))}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued">
                    No products selected
                  </Text>
                )}
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Collections
                  </Text>
                  <Button onClick={openCollectionPicker}>Browse collections</Button>
                </InlineStack>
                {targetCollections.length > 0 ? (
                  <InlineStack gap="200" wrap>
                    {targetCollections.map((collection) => (
                      <Tag key={collection.id} onRemove={() => removeCollection(collection.id)}>
                        {collection.title || `Collection ${collection.id}`}
                      </Tag>
                    ))}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued">
                    No collections selected
                  </Text>
                )}
                {targetCollections.length > 0 ? (
                  <Text as="p" tone="subdued">
                    All products in these collections will automatically show this field.
                  </Text>
                ) : null}
              </BlockStack>

              {!hasTargets ? (
                <>
                  <Divider />
                  <Text as="p" tone="critical">
                    Select at least one product or collection.
                  </Text>
                </>
              ) : null}
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
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Content Type
              </Text>
              <Checkbox
                label="Restrict allowed file types"
                checked={contentTypeRestricted}
                onChange={(checked) => {
                  setContentTypeRestricted(checked);
                  if (checked && allowedExtensions.length === 0) {
                    setAllowedExtensions(["png", "jpg", "jpeg", "pdf"]);
                  }
                }}
              />
              {!contentTypeRestricted ? (
                <Text as="p" tone="subdued">
                  All file types are accepted.
                </Text>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    Only the file types listed below will be accepted.
                  </Text>
                  <BlockStack gap="200">
                    {[
                      { label: "Images (png, jpg, jpeg)", exts: ["png", "jpg", "jpeg"] },
                      { label: "PDF", exts: ["pdf"] },
                      { label: "SVG", exts: ["svg"] },
                      { label: "Adobe (ai, psd, eps)", exts: ["ai", "psd", "eps"] },
                      { label: "TIFF", exts: ["tif", "tiff"] },
                    ].map((group) => {
                      const allIncluded = group.exts.every((ext) => allowedExtensions.includes(ext));
                      return (
                        <Checkbox
                          key={group.label}
                          label={group.label}
                          checked={allIncluded}
                          onChange={(checked) => {
                            setAllowedExtensions((prev) => {
                              const without = prev.filter((ext) => !group.exts.includes(ext));
                              return checked ? [...without, ...group.exts] : without;
                            });
                          }}
                        />
                      );
                    })}
                  </BlockStack>

                  <Divider />

                  <InlineStack gap="200" wrap>
                    {allowedExtensions.map((ext) => (
                      <Tag key={ext} onRemove={() => setAllowedExtensions((prev) => prev.filter((item) => item !== ext))}>
                        .{ext}
                      </Tag>
                    ))}
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ minWidth: 180 }}>
                      <TextField
                        label="Add custom extension"
                        value={newExtension}
                        autoComplete="off"
                        onChange={setNewExtension}
                        placeholder="e.g. webp"
                      />
                    </div>
                    <Button
                      onClick={() => {
                        const normalized = newExtension.trim().toLowerCase().replace(/^\./, "");
                        if (normalized && !allowedExtensions.includes(normalized)) {
                          setAllowedExtensions((prev) => [...prev, normalized]);
                        }
                        setNewExtension("");
                      }}
                    >
                      Add
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                File Rules
              </Text>
              <FormLayout>
                <TextField
                  name="maxFileMB"
                  label="Max file size"
                  type="number"
                  suffix="MB"
                  autoComplete="off"
                  value={maxFileMB}
                  onChange={setMaxFileMB}
                  helpText={`Your plan allows up to ${maxFileMBFromPlan}MB`}
                />
                {Number(maxFileMB) > maxFileMBFromPlan && (
                  <Banner
                    title="File size exceeds your plan limit"
                    tone="warning"
                    action={{ content: "Upgrade plan", url: "/app/plans" }}
                  >
                    Your {planCode} plan supports up to {maxFileMBFromPlan}MB per
                    file. Upgrade to increase this limit.
                  </Banner>
                )}
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
            <BlockStack gap="400">
              <BlockStack gap="150">
                <Text as="h2" variant="headingMd">
                  Dynamic pricing
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Optional add-on fees for this upload field, calculated when the customer
                  uploads a file. Shown before checkout with the rest of the line item.
                </Text>
              </BlockStack>

              {!planAllowsDynamicPricing ? (
                <input type="hidden" name="pricingEnabled" value="" />
              ) : null}

              {planAllowsDynamicPricing ? (
                <Checkbox
                  name="pricingEnabled"
                  label="Charge using dynamic pricing"
                  helpText="When off, no upload fee is added from this field."
                  checked={pricingEnabled}
                  onChange={setPricingEnabled}
                />
              ) : (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <InlineStack gap="400" align="space-between" blockAlign="center" wrap>
                      <Checkbox
                        label="Charge using dynamic pricing"
                        checked={false}
                        onChange={setPricingEnabled}
                        disabled
                      />
                      <Button url="/app/plans" variant="primary">
                        Upgrade plan
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodyMd">
                      Per-file and dimension-based rates are on{" "}
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Pro
                      </Text>{" "}
                      and{" "}
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Business
                      </Text>
                      . Upgrade to unlock this section.
                    </Text>
                  </BlockStack>
                </Box>
              )}

              {!(planAllowsDynamicPricing && pricingEnabled) ? (
                <>
                  <input type="hidden" name="pricingUnitType" value={pricingUnitType} />
                  <input type="hidden" name="unitPrice" value={unitPrice} />
                  <input type="hidden" name="minPrice" value={minPrice} />
                  <input type="hidden" name="dpi" value={dpi} />
                  <input type="hidden" name="printWidth" value={printWidth} />
                  <input type="hidden" name="roundingEnabled" value={roundingEnabled ? "on" : ""} />
                </>
              ) : null}

              {planAllowsDynamicPricing && !pricingEnabled ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Turn on dynamic pricing to set how the upload fee is calculated.
                </Text>
              ) : null}

              {planAllowsDynamicPricing && pricingEnabled ? (
                <BlockStack gap="300">
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Rate settings
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {
                      "These values are used together with the customer's file metadata (size, dimensions) where applicable."
                    }
                  </Text>
                  <FormLayout>
                    <Select
                      name="pricingUnitType"
                      label="Calculation method"
                      helpText="Pick how the fee scales with the uploaded file."
                      value={pricingUnitType}
                      options={[
                        { label: "Flat — fixed price per upload", value: "flat" },
                        { label: "Per file — price × number of files", value: "per_file" },
                        { label: "Per inch height — price × print height", value: "inch_height" },
                        { label: "Per square inch — price × print area", value: "inch_square" },
                      ]}
                      onChange={(value) =>
                        setPricingUnitType(value as UploadFieldConfig["pricing"]["unitType"])
                      }
                    />
                    <InlineStack gap="400" align="start" blockAlign="start" wrap>
                      <Box minWidth="200px" width="100%">
                        <TextField
                          name="unitPrice"
                          label="Rate"
                          type="number"
                          prefix="$"
                          autoComplete="off"
                          value={unitPrice}
                          onChange={setUnitPrice}
                          helpText="Base unit for the method above (e.g. per inch or per file)."
                        />
                      </Box>
                      <Box minWidth="200px" width="100%">
                        <TextField
                          name="minPrice"
                          label="Floor price"
                          type="number"
                          prefix="$"
                          autoComplete="off"
                          value={minPrice}
                          onChange={setMinPrice}
                          helpText="Minimum fee charged for an upload (0 = no floor)."
                        />
                      </Box>
                    </InlineStack>
                    <InlineStack gap="400" align="start" blockAlign="start" wrap>
                      <Box minWidth="200px" width="100%">
                        <TextField
                          name="dpi"
                          label="Assumed DPI"
                          type="number"
                          suffix="DPI"
                          helpText="Used to convert pixels to physical inches for area/height pricing."
                          autoComplete="off"
                          value={dpi}
                          onChange={setDpi}
                        />
                      </Box>
                      <Box minWidth="200px" width="100%">
                        <TextField
                          name="printWidth"
                          label="Roll / print width"
                          type="number"
                          suffix="in"
                          helpText="Reference width for layout calculations (e.g. wide-format rolls)."
                          autoComplete="off"
                          value={printWidth}
                          onChange={setPrintWidth}
                        />
                      </Box>
                    </InlineStack>
                    <Checkbox
                      name="roundingEnabled"
                      label="Round calculated price to a cleaner amount"
                      checked={roundingEnabled}
                      onChange={setRoundingEnabled}
                      helpText="Helps avoid long decimal prices on the storefront."
                    />
                  </FormLayout>
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <BlockStack gap="150">
                <Text as="h2" variant="headingMd">
                  Dimension rules
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Block uploads or show warnings when artwork does not meet DPI, size, or
                  other limits. Evaluated when the customer uploads a file.
                </Text>
              </BlockStack>

              {planAllowsAdvancedValidation ? (
                <BlockStack gap="300">
                  {dimensionRules.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No rules yet. Add a rule to enforce limits on uploaded files.
                    </Text>
                  ) : null}
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
                                itemIndex === index
                                  ? { ...item, dimensionType: value as FieldDimensionType }
                                  : item,
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
                                itemIndex === index ? { ...item, operator: value as FieldOperator } : item,
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
                          setDimensionRules((prev) =>
                            prev.filter((_, itemIndex) => itemIndex !== index),
                          )
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
                    Add rule
                  </Button>
                </BlockStack>
              ) : (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <Text as="p" variant="bodyMd">
                      DPI, pixel size, print dimensions, and page-count rules are on{" "}
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Starter
                      </Text>
                      ,{" "}
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Pro
                      </Text>
                      , and{" "}
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Business
                      </Text>
                      . Upgrade to add dimension rules for this field.
                    </Text>
                    <Button url="/app/plans" variant="primary">
                      Upgrade plan
                    </Button>
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Card>

          <InlineStack gap="200">
            <Button submit variant="primary" disabled={fieldCreationBlocked}>
              Save Field
            </Button>
            <Button url="/app/fields">Back to Fields</Button>
            {firstProductHandle ? (
              <Button url={`https://${shopDomain}/products/${firstProductHandle}`} target="_blank">
                Preview Product
              </Button>
            ) : null}
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
