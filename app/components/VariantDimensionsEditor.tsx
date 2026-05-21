import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Checkbox,
  Collapsible,
  Divider,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";
import type { FieldTargetProduct } from "../types/printdock";
import type { ShopifyVariantRow } from "../utils/field-target-product-variants-ui";
import { parseVariantDimensions } from "../utils/variant-dimensions";
import {
  formatVariantDimensionSummary,
  type VariantDimensionInputs,
  variantInputHasSavedDimensions,
} from "../utils/field-target-product-variants";

type VariantsLoaderData = {
  variants?: ShopifyVariantRow[];
  error?: string;
};

type SaveVariantDimensionsActionData = {
  ok?: boolean;
  error?: string;
  variant?: {
    variantId: string;
    width?: number;
    height?: number;
  } | null;
};

type RowMode = "empty" | "saved" | "editing";

type VariantDimensionsEditorProps = {
  fieldId: string;
  isNew: boolean;
  targetProducts: FieldTargetProduct[];
  savedVariantInputs: VariantDimensionInputs;
  onSavedVariantInputsChange: Dispatch<SetStateAction<VariantDimensionInputs>>;
  onShopifyVariantsChange?: (variants: ShopifyVariantRow[]) => void;
};

function isValidDimensionInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0;
}

function draftHasSaveableDimensions(input: { width: string; height: string }): boolean {
  return isValidDimensionInput(input.width) &&
    isValidDimensionInput(input.height) &&
    Boolean(input.width.trim() || input.height.trim());
}

function suggestDimensionsForEmptyDrafts(
  savedInputs: VariantDimensionInputs,
  drafts: VariantDimensionInputs,
  rowModes: Record<string, RowMode>,
  variants: readonly ShopifyVariantRow[],
): VariantDimensionInputs {
  let changed = false;
  const next = { ...drafts };

  for (const variant of variants) {
    const mode = rowModes[variant.variantId] ?? "empty";
    if (mode === "saved") continue;

    const saved = savedInputs[variant.variantId];
    if (saved && variantInputHasSavedDimensions(saved)) continue;

    const current = next[variant.variantId] ?? { width: "", height: "" };
    if (current.width.trim() || current.height.trim()) continue;

    const parsed = parseVariantDimensions(variant.title);
    if (!parsed) continue;

    next[variant.variantId] = {
      width: String(parsed.width),
      height: String(parsed.height),
    };
    changed = true;
  }

  return changed ? next : drafts;
}

function buildInitialRowModes(savedInputs: VariantDimensionInputs): Record<string, RowMode> {
  const modes: Record<string, RowMode> = {};
  for (const [variantId, input] of Object.entries(savedInputs)) {
    if (variantInputHasSavedDimensions(input)) {
      modes[variantId] = "saved";
    }
  }
  return modes;
}

export function VariantDimensionsEditor({
  fieldId,
  isNew,
  targetProducts,
  savedVariantInputs,
  onSavedVariantInputsChange,
  onShopifyVariantsChange,
}: VariantDimensionsEditorProps) {
  const appBridge = useAppBridge();
  const fetcher = useFetcher<SaveVariantDimensionsActionData>();
  const variantsFetcher = useFetcher<VariantsLoaderData>();
  const prefilledVariantIdsRef = useRef<Set<string>>(new Set());
  const lastSubmittedVariantIdRef = useRef<string | null>(null);

  const [sectionOpen, setSectionOpen] = useState(() =>
    Object.values(savedVariantInputs).some(variantInputHasSavedDimensions),
  );
  const [rowModes, setRowModes] = useState<Record<string, RowMode>>(() =>
    buildInitialRowModes(savedVariantInputs),
  );
  const [rowDrafts, setRowDrafts] = useState<VariantDimensionInputs>({});

  const productIds = useMemo(
    () => targetProducts.map((product) => product.id).filter(Boolean),
    [targetProducts],
  );
  const productIdsKey = productIds.join(",");

  useEffect(() => {
    if (productIds.length === 0) return;
    const params = new URLSearchParams();
    for (const productId of productIds) {
      params.append("productId", productId);
    }
    variantsFetcher.load(`/app/fields/variants?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productIdsKey]);

  const shopifyVariants = variantsFetcher.data?.variants ?? [];
  const isLoading = variantsFetcher.state !== "idle" && shopifyVariants.length === 0;
  const loadError = variantsFetcher.data && "error" in variantsFetcher.data ? variantsFetcher.data.error : null;

  useEffect(() => {
    onShopifyVariantsChange?.(shopifyVariants);
  }, [onShopifyVariantsChange, shopifyVariants]);

  useEffect(() => {
    if (shopifyVariants.length === 0) return;

    setRowDrafts((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const variant of shopifyVariants) {
        if (prefilledVariantIdsRef.current.has(variant.variantId)) continue;

        const saved = savedVariantInputs[variant.variantId];
        if (saved && variantInputHasSavedDimensions(saved)) {
          prefilledVariantIdsRef.current.add(variant.variantId);
          setRowModes((modes) =>
            modes[variant.variantId] ? modes : { ...modes, [variant.variantId]: "saved" },
          );
          continue;
        }

        const parsed = parseVariantDimensions(variant.title);
        prefilledVariantIdsRef.current.add(variant.variantId);
        if (!parsed) continue;

        next[variant.variantId] = {
          width: String(parsed.width),
          height: String(parsed.height),
        };
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [savedVariantInputs, shopifyVariants]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !lastSubmittedVariantIdRef.current) return;

    const submittedVariantId = lastSubmittedVariantIdRef.current;
    lastSubmittedVariantIdRef.current = null;

    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      appBridge.toast.show(fetcher.data.error, { isError: true });
      return;
    }

    if (!fetcher.data?.ok) return;

    const variantId = submittedVariantId;
    const savedVariant = fetcher.data.variant;

    if (savedVariant) {
      onSavedVariantInputsChange((prev) => ({
        ...prev,
        [variantId]: {
          width: savedVariant.width != null ? String(savedVariant.width) : "",
          height: savedVariant.height != null ? String(savedVariant.height) : "",
        },
      }));
      setRowModes((prev) => ({ ...prev, [variantId]: "saved" }));
    } else {
      onSavedVariantInputsChange((prev) => {
        const next = { ...prev };
        delete next[variantId];
        return next;
      });
      setRowModes((prev) => ({ ...prev, [variantId]: "empty" }));
    }

    setRowDrafts((prev) => {
      const next = { ...prev };
      delete next[variantId];
      return next;
    });

    appBridge.toast.show(
      savedVariant ? "Variant dimensions saved" : "Variant dimensions cleared",
    );
  }, [appBridge, fetcher.data, fetcher.state, onSavedVariantInputsChange]);

  const variantsByProduct = useMemo(() => {
    const grouped = new Map<string, ShopifyVariantRow[]>();
    for (const variant of shopifyVariants) {
      const list = grouped.get(variant.productId) ?? [];
      list.push(variant);
      grouped.set(variant.productId, list);
    }
    return grouped;
  }, [shopifyVariants]);

  const configuredCount = useMemo(() => {
    return Object.values(savedVariantInputs).filter(variantInputHasSavedDimensions).length;
  }, [savedVariantInputs]);

  const handleSuggestFromTitles = useCallback(() => {
    setRowDrafts((prev) =>
      suggestDimensionsForEmptyDrafts(savedVariantInputs, prev, rowModes, shopifyVariants),
    );
  }, [rowModes, savedVariantInputs, shopifyVariants]);

  const setDraftValue = useCallback(
    (variantId: string, field: "width" | "height", value: string) => {
      setRowDrafts((prev) => ({
        ...prev,
        [variantId]: {
          width: field === "width" ? value : (prev[variantId]?.width ?? ""),
          height: field === "height" ? value : (prev[variantId]?.height ?? ""),
        },
      }));
    },
    [],
  );

  const commitRowLocally = useCallback(
    (variantId: string, draft: { width: string; height: string }) => {
      onSavedVariantInputsChange((prev) => ({
        ...prev,
        [variantId]: {
          width: draft.width.trim(),
          height: draft.height.trim(),
        },
      }));
      setRowModes((prev) => ({ ...prev, [variantId]: "saved" }));
      setRowDrafts((prev) => {
        const next = { ...prev };
        delete next[variantId];
        return next;
      });
    },
    [onSavedVariantInputsChange],
  );

  const submitRowSave = useCallback(
    (productId: string, variantId: string, draft: { width: string; height: string }) => {
      if (isNew) {
        commitRowLocally(variantId, draft);
        appBridge.toast.show("Variant dimensions saved locally. Save the field to persist.");
        return;
      }

      lastSubmittedVariantIdRef.current = variantId;
      fetcher.submit(
        {
          intent: "save_variant_dimensions",
          productId,
          variantId,
          width: draft.width.trim(),
          height: draft.height.trim(),
        },
        { method: "post", action: `/app/fields/${fieldId}` },
      );
    },
    [appBridge, commitRowLocally, fetcher, fieldId, isNew],
  );

  const submitRowClear = useCallback(
    (productId: string, variantId: string) => {
      if (isNew) {
        onSavedVariantInputsChange((prev) => {
          const next = { ...prev };
          delete next[variantId];
          return next;
        });
        setRowModes((prev) => ({ ...prev, [variantId]: "empty" }));
        setRowDrafts((prev) => {
          const next = { ...prev };
          delete next[variantId];
          return next;
        });
        return;
      }

      lastSubmittedVariantIdRef.current = variantId;
      fetcher.submit(
        {
          intent: "save_variant_dimensions",
          productId,
          variantId,
          width: "",
          height: "",
        },
        { method: "post", action: `/app/fields/${fieldId}` },
      );
    },
    [fetcher, fieldId, isNew, onSavedVariantInputsChange],
  );

  const startEditing = useCallback(
    (variantId: string) => {
      const saved = savedVariantInputs[variantId] ?? { width: "", height: "" };
      setRowDrafts((prev) => ({
        ...prev,
        [variantId]: { width: saved.width, height: saved.height },
      }));
      setRowModes((prev) => ({ ...prev, [variantId]: "editing" }));
    },
    [savedVariantInputs],
  );

  const cancelEditing = useCallback((variantId: string) => {
    setRowDrafts((prev) => {
      const next = { ...prev };
      delete next[variantId];
      return next;
    });
    setRowModes((prev) => ({ ...prev, [variantId]: "saved" }));
  }, []);

  if (productIds.length === 0) return null;

  const savingVariantId =
    fetcher.state !== "idle" ? lastSubmittedVariantIdRef.current : null;

  return (
    <>
      <Divider />
      <BlockStack gap="300">
        <Checkbox
          label="Set variant dimensions (inches)"
          helpText="Optional expected print size per variant. Used for future upload checks — not enforced at upload time in this version."
          checked={sectionOpen}
          onChange={setSectionOpen}
        />

        {!sectionOpen && configuredCount > 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {configuredCount} variant{configuredCount === 1 ? "" : "s"} configured
          </Text>
        ) : null}

        <Collapsible open={sectionOpen} id="variant-dimensions-collapsible">
          <BlockStack gap="300">
            {isNew ? (
              <Banner tone="info">
                Save the field first to persist variant dimensions individually. Until then, row
                saves are kept locally and included when you save the field.
              </Banner>
            ) : null}

            <InlineStack align="end">
              <Button onClick={handleSuggestFromTitles} disabled={shopifyVariants.length === 0}>
                Suggest from titles
              </Button>
            </InlineStack>

            {loadError ? (
              <Text as="p" tone="critical">
                {loadError}
              </Text>
            ) : null}

            {isLoading ? (
              <Text as="p" tone="subdued">
                Loading variants…
              </Text>
            ) : null}

            {!isLoading && shopifyVariants.length === 0 ? (
              <Text as="p" tone="subdued">
                No variants found for the selected products.
              </Text>
            ) : null}

            {targetProducts.map((product) => {
              const variants = variantsByProduct.get(product.id) ?? [];
              if (variants.length === 0) return null;

              return (
                <BlockStack gap="200" key={product.id}>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {product.title || `Product ${product.id}`}
                  </Text>
                  <BlockStack gap="200">
                    {variants.map((variant) => {
                      const mode = rowModes[variant.variantId] ?? "empty";
                      const saved = savedVariantInputs[variant.variantId] ?? { width: "", height: "" };
                      const isSavingRow = savingVariantId === variant.variantId;

                      if (mode === "saved") {
                        const width = saved.width.trim() ? Number(saved.width) : undefined;
                        const height = saved.height.trim() ? Number(saved.height) : undefined;
                        return (
                          <Box
                            key={variant.variantId}
                            padding="300"
                            background="bg-surface-secondary"
                            borderRadius="200"
                          >
                            <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
                              <Box minWidth="180px">
                                <BlockStack gap="100">
                                  <Text as="p" variant="bodySm" fontWeight="semibold">
                                    {variant.title}
                                  </Text>
                                  {variant.sku ? (
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      SKU: {variant.sku}
                                    </Text>
                                  ) : null}
                                </BlockStack>
                              </Box>
                              <Text as="p" variant="bodySm">
                                {formatVariantDimensionSummary(width, height)}
                              </Text>
                              <InlineStack gap="200">
                                <Button onClick={() => startEditing(variant.variantId)}>
                                  Edit
                                </Button>
                                <Button
                                  onClick={() => submitRowClear(product.id, variant.variantId)}
                                  loading={isSavingRow}
                                  disabled={fetcher.state !== "idle" && !isSavingRow}
                                >
                                  Clear
                                </Button>
                              </InlineStack>
                            </InlineStack>
                          </Box>
                        );
                      }

                      const displayDraft = rowDrafts[variant.variantId] ?? { width: "", height: "" };
                      const widthInvalid = !isValidDimensionInput(displayDraft.width);
                      const heightInvalid = !isValidDimensionInput(displayDraft.height);
                      const canSave = draftHasSaveableDimensions(displayDraft);

                      return (
                        <Box
                          key={variant.variantId}
                          padding="300"
                          background="bg-surface-secondary"
                          borderRadius="200"
                        >
                          <InlineStack gap="300" align="start" blockAlign="start" wrap>
                            <Box minWidth="180px">
                              <BlockStack gap="100">
                                <Text as="p" variant="bodySm" fontWeight="semibold">
                                  {variant.title}
                                </Text>
                                {variant.sku ? (
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    SKU: {variant.sku}
                                  </Text>
                                ) : null}
                              </BlockStack>
                            </Box>
                            <Box minWidth="120px">
                              <TextField
                                label="W"
                                labelHidden
                                prefix="W"
                                suffix="in"
                                type="text"
                                inputMode="decimal"
                                autoComplete="off"
                                value={displayDraft.width}
                                onChange={(value) => setDraftValue(variant.variantId, "width", value)}
                                error={widthInvalid ? "Enter a positive number" : undefined}
                              />
                            </Box>
                            <Box minWidth="120px">
                              <TextField
                                label="H"
                                labelHidden
                                prefix="H"
                                suffix="in"
                                type="text"
                                inputMode="decimal"
                                autoComplete="off"
                                value={displayDraft.height}
                                onChange={(value) => setDraftValue(variant.variantId, "height", value)}
                                error={heightInvalid ? "Enter a positive number" : undefined}
                              />
                            </Box>
                            <InlineStack gap="200">
                              <Button
                                variant="primary"
                                disabled={!canSave}
                                loading={isSavingRow}
                                onClick={() =>
                                  submitRowSave(product.id, variant.variantId, displayDraft)
                                }
                              >
                                Save
                              </Button>
                              {mode === "editing" ? (
                                <Button onClick={() => cancelEditing(variant.variantId)}>
                                  Cancel
                                </Button>
                              ) : null}
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              );
            })}
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </>
  );
}
