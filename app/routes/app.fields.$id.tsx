import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useCallback, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
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
import {
  canUseFeature,
  fileSizeUpgradeReason,
  getPlan,
  isWithinFieldLimit,
  merchantUpgradeHint,
  planDisplayName,
  suggestUpgradeFor,
} from "../config/plans";
import { getEffectiveBillingPlan, getUploadField, listUploadFields, saveUploadField } from "../services/shop-data.server";
import { FieldTargetOverlapBannerContent } from "../components/FieldTargetOverlapBannerContent";
import { TargetResourcePickerModal } from "../components/TargetResourcePickerModal";
import {
  activeFieldParticipatesInTargetOverlap,
  analyzeActiveFieldTargetOverlaps,
  fieldWithEditorTargets,
} from "../utils/field-target-overlaps";
import type {
  FieldDimensionType,
  FieldTargetCollection,
  FieldTargetProduct,
  UploadFieldConfig,
  UploadFieldDimensionRule,
} from "../types/printdock";
import { DEFAULT_FILE_RENAME_PATTERN, previewRenamedFileName } from "../utils/file-rename-pattern";
import { useNewValueEffect } from "../hooks/useNewValueEffect";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

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
    fileRenamingPattern: DEFAULT_FILE_RENAME_PATTERN,
    minFiles: 1,
    maxFiles: 1,
    allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
    maxFileMB: 50,
    pricing: {
      enabled: false,
      unitType: "flat",
      unitPrice: 0,
      minPrice: 0,
      roundingEnabled: true,
    },
    dimensionRules: [],
    planRequirement: "free",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

type SupportedDimensionType = "widthInch" | "heightInch" | "dpi";
type DimensionRuleMode = "off" | "fixed" | "range";

type DimensionCard = {
  dimensionType: SupportedDimensionType;
  mode: DimensionRuleMode;
  groupId: string;
  fixedValue: string;
  rangeMin: string;
  rangeMax: string;
};

const SUPPORTED_DIMENSIONS: SupportedDimensionType[] = ["widthInch", "heightInch", "dpi"];

function dimensionLabel(dimensionType: SupportedDimensionType): string {
  if (dimensionType === "widthInch") return "Width";
  if (dimensionType === "heightInch") return "Height";
  return "DPI";
}

function dimensionSuffix(dimensionType: SupportedDimensionType): string {
  return dimensionType === "dpi" ? "DPI" : "in";
}

function numberToInput(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "";
  return String(Number(value.toFixed(4)));
}

function inputToFiniteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureFiniteValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeRuleToken(groupId: string, operator: string, value: number): string {
  return `v1|${groupId}|${operator}|${value}`;
}

function defaultDimensionCard(dimensionType: SupportedDimensionType): DimensionCard {
  return {
    dimensionType,
    mode: "off",
    groupId: crypto.randomUUID(),
    fixedValue: "",
    rangeMin: "",
    rangeMax: "",
  };
}

function deriveDimensionCards(
  rules: UploadFieldDimensionRule[],
): {
  cards: Record<SupportedDimensionType, DimensionCard>;
  legacyRules: UploadFieldDimensionRule[];
  simplifiedLegacyRules: boolean;
} {
  const cards: Record<SupportedDimensionType, DimensionCard> = {
    widthInch: defaultDimensionCard("widthInch"),
    heightInch: defaultDimensionCard("heightInch"),
    dpi: defaultDimensionCard("dpi"),
  };
  let simplifiedLegacyRules = false;
  const legacyRules: UploadFieldDimensionRule[] = [];

  for (const dimensionType of SUPPORTED_DIMENSIONS) {
    const groupRules = rules.filter((rule) => rule.dimensionType === dimensionType);
    if (groupRules.length === 0) continue;

    const gteRules = groupRules.filter((rule) => rule.operator === "gte").map((rule) => ensureFiniteValue(rule.value));
    const lteRules = groupRules.filter((rule) => rule.operator === "lte").map((rule) => ensureFiniteValue(rule.value));
    const eqRules = groupRules.filter((rule) => rule.operator === "eq").map((rule) => ensureFiniteValue(rule.value));
    const gtRules = groupRules.filter((rule) => rule.operator === "gt").map((rule) => ensureFiniteValue(rule.value));
    const ltRules = groupRules.filter((rule) => rule.operator === "lt").map((rule) => ensureFiniteValue(rule.value));

    const card = cards[dimensionType];
    card.groupId = groupRules[0]?.groupId || groupRules[0]?.id || crypto.randomUUID();

    const lowerCandidates = [...gteRules, ...gtRules];
    const upperCandidates = [...lteRules, ...ltRules];
    const hasComplexShape =
      groupRules.length > 2 ||
      eqRules.length > 1 ||
      gteRules.length > 1 ||
      lteRules.length > 1 ||
      gtRules.length > 0 ||
      ltRules.length > 0;

    if (eqRules.length > 0) {
      if (hasComplexShape) simplifiedLegacyRules = true;
      card.mode = "fixed";
      card.fixedValue = numberToInput(eqRules[0]);
      continue;
    }

    const lowerBound = lowerCandidates.length > 0 ? Math.max(...lowerCandidates) : null;
    const upperBound = upperCandidates.length > 0 ? Math.min(...upperCandidates) : null;

    if (lowerBound === null && upperBound === null) {
      simplifiedLegacyRules = true;
      continue;
    }

    if (lowerBound !== null && upperBound !== null) {
      if (lowerBound > upperBound) {
        simplifiedLegacyRules = true;
        card.mode = "range";
        card.rangeMin = numberToInput(lowerBound);
        card.rangeMax = "";
        continue;
      }

      if (lowerBound === upperBound) {
        card.mode = "fixed";
        card.fixedValue = numberToInput(lowerBound);
      } else {
        card.mode = "range";
        card.rangeMin = numberToInput(lowerBound);
        card.rangeMax = numberToInput(upperBound);
      }

      if (hasComplexShape) simplifiedLegacyRules = true;
      continue;
    }

    card.mode = "range";
    card.rangeMin = numberToInput(lowerBound);
    card.rangeMax = numberToInput(upperBound);
    if (hasComplexShape) simplifiedLegacyRules = true;
  }

  for (const rule of rules) {
    if (!SUPPORTED_DIMENSIONS.includes(rule.dimensionType as SupportedDimensionType)) {
      legacyRules.push({
        ...rule,
        action: "prevent",
      });
    }
  }

  if (rules.some((rule) => rule.action === "warning")) {
    simplifiedLegacyRules = true;
  }

  return { cards, legacyRules, simplifiedLegacyRules };
}

function serializeDimensionCards(
  cards: Record<SupportedDimensionType, DimensionCard>,
  allowedDimensions: SupportedDimensionType[],
  legacyRules: UploadFieldDimensionRule[],
): UploadFieldDimensionRule[] {
  const nextRules: UploadFieldDimensionRule[] = [];

  for (const dimensionType of allowedDimensions) {
    const card = cards[dimensionType];
    if (!card || card.mode === "off") continue;

    const groupId = card.groupId || crypto.randomUUID();

    if (card.mode === "fixed") {
      const fixed = inputToFiniteNumber(card.fixedValue);
      if (fixed === null) continue;
      const value = Number(fixed.toFixed(4));
      nextRules.push({
        id: crypto.randomUUID(),
        groupId,
        dimensionType,
        operator: "eq",
        value,
        action: "prevent",
        warningMessage: makeRuleToken(groupId, "eq", value),
      });
      continue;
    }

    const minValue = inputToFiniteNumber(card.rangeMin);
    const maxValue = inputToFiniteNumber(card.rangeMax);

    if (minValue !== null) {
      nextRules.push({
        id: crypto.randomUUID(),
        groupId,
        dimensionType,
        operator: "gte",
        value: Number(minValue.toFixed(4)),
        action: "prevent",
        warningMessage: makeRuleToken(groupId, "gte", Number(minValue.toFixed(4))),
      });
    }

    if (maxValue !== null) {
      nextRules.push({
        id: crypto.randomUUID(),
        groupId,
        dimensionType,
        operator: "lte",
        value: Number(maxValue.toFixed(4)),
        action: "prevent",
        warningMessage: makeRuleToken(groupId, "lte", Number(maxValue.toFixed(4))),
      });
    }
  }

  return [
    ...nextRules,
    ...legacyRules.map((rule) => {
      const groupId = rule.groupId || rule.id || crypto.randomUUID();
      const value = ensureFiniteValue(rule.value);
      return {
        ...rule,
        groupId,
        value,
        action: "prevent" as const,
        warningMessage: makeRuleToken(groupId, rule.operator, value),
      };
    }),
  ];
}

function normalizeIncomingDimensionRules(
  rawRules: UploadFieldConfig["dimensionRules"],
): UploadFieldConfig["dimensionRules"] {
  return rawRules
    .filter(
      (rule) =>
        rule &&
        typeof rule.id === "string" &&
        typeof rule.dimensionType === "string" &&
        typeof rule.operator === "string",
    )
    .map((rule) => {
      const groupId = (rule.groupId || rule.id || crypto.randomUUID()).trim();
      const value = ensureFiniteValue(rule.value);
      return {
        ...rule,
        id: rule.id || crypto.randomUUID(),
        groupId,
        value,
        action: "prevent" as const,
        warningMessage: makeRuleToken(groupId, rule.operator, value),
      };
    });
}

function allowedDimensionTypesForMethod(
  unitType: UploadFieldConfig["pricing"]["unitType"],
): FieldDimensionType[] {
  if (unitType === "inch_height") {
    return ["heightInch", "dpi"];
  }
  return ["widthInch", "heightInch", "dpi"];
}

function unitPriceLabelForMethod(unitType: UploadFieldConfig["pricing"]["unitType"]): string {
  if (unitType === "inch_height") return "Price per inch of height";
  if (unitType === "inch_square") return "Price per square inch";
  return "Flat price";
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const id = params.id || "new";
      log.event("admin_page_view", { path: `/app/fields/${id}` });

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

      const allFields = await listUploadFields(session.shop);
      const fieldCreationBlocked =
        id === "new" ? !isWithinFieldLimit(billingPlan.planCode, allFields.length) : false;

      return data({
        field,
        isNew: id === "new",
        shopDomain: session.shop,
        planCode: billingPlan.planCode,
        maxFileMBFromPlan,
        fieldCreationBlocked,
        allFields,
      });
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_field_editor_loader_failed", err, {
        path: `/app/fields/${params.id || "new"}`,
      });
      throw err;
    }
  });
};

const FILE_SIZE_LIMITS = { min: 1, step: 1 } as const;
const PRICE_LIMITS = { min: 0, max: 9999, step: 0.00000001 } as const;
const DIMENSION_INCH_LIMITS = { min: 0.01, max: 500, step: 0.01 } as const;
const DIMENSION_DPI_LIMITS = { min: 1, max: 2400, step: 1 } as const;

type NumericRange = { min: number; max: number };

function parseBoundedNumberInput(
  raw: FormDataEntryValue | null,
  label: string,
  range: NumericRange,
  fallback: number,
  options?: { allowDecimalComma?: boolean },
): { value: number; error: string | null } {
  if (raw === null || String(raw).trim() === "") {
    return { value: fallback, error: null };
  }
  const text = String(raw).trim();
  if (options?.allowDecimalComma && text.includes(",") && text.includes(".")) {
    return {
      value: fallback,
      error: `${label} must use either comma or dot as decimal separator, not both.`,
    };
  }
  const normalizedText = options?.allowDecimalComma ? text.replace(",", ".") : text;
  const parsed = Number(normalizedText);
  if (!Number.isFinite(parsed)) {
    return { value: fallback, error: `${label} must be a valid number.` };
  }
  if (parsed < range.min || parsed > range.max) {
    return {
      value: fallback,
      error: `${label} must be between ${range.min} and ${range.max}.`,
    };
  }
  return { value: parsed, error: null };
}

function getDimensionNumericLimits(
  dimensionType: SupportedDimensionType,
): { min: number; max: number; step: number } {
  if (dimensionType === "dpi") return DIMENSION_DPI_LIMITS;
  return DIMENSION_INCH_LIMITS;
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
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
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
          dimensionRules = normalizeIncomingDimensionRules(parsedRules);
        }
      } catch {
        return data({ error: "Dimension rules must be valid JSON array" }, { status: 400 });
      }

      const existingField = id !== "new" ? await getUploadField(session.shop, id) : null;
      if (id !== "new" && !existingField) {
        return data({ error: "This field no longer exists or was removed." }, { status: 404 });
      }
      const fieldId = id === "new" ? crypto.randomUUID() : id;
      const requestedPricingEnabled = parseBoolean(formData.get("pricingEnabled"));
      const requestedPricingUnitType = String(formData.get("pricingUnitType"));
      const pricingUnitType: UploadFieldConfig["pricing"]["unitType"] =
        requestedPricingUnitType === "inch_height" || requestedPricingUnitType === "inch_square"
          ? requestedPricingUnitType
          : "flat";

      const planCode = billingPlan.planCode;
      const planAllowsDynamicPricing = canUseFeature(planCode, "dynamicPricing");
      const pricingEnabled = planAllowsDynamicPricing ? requestedPricingEnabled : false;
      const planLimits = getPlan(planCode);
      const maxFileMBFromPlan = Math.floor(planLimits.maxFileSizeBytes / (1024 * 1024));
      const maxFileMBParse = parseBoundedNumberInput(
        formData.get("maxFileMB"),
        "Max file size",
        { min: FILE_SIZE_LIMITS.min, max: maxFileMBFromPlan },
        50,
      );
      if (maxFileMBParse.error) {
        return data({ error: maxFileMBParse.error }, { status: 400 });
      }
      const maxFileMB = maxFileMBParse.value;

      if (!canUseFeature(planCode, "advancedValidation")) {
        dimensionRules = [];
      }

      if (id === "new") {
        const allFields = await listUploadFields(session.shop);
        if (!isWithinFieldLimit(planCode, allFields.length)) {
          return data({ error: merchantUpgradeHint("moreUploadFields") }, { status: 402 });
        }
      }

      if (maxFileMB > maxFileMBFromPlan) {
        return data({ error: merchantUpgradeHint(fileSizeUpgradeReason(planCode)) }, { status: 402 });
      }

      const unitPriceParse = parseBoundedNumberInput(
        formData.get("unitPrice"),
        unitPriceLabelForMethod(pricingUnitType),
        PRICE_LIMITS,
        existingField?.pricing.unitPrice ?? 0,
        { allowDecimalComma: true },
      );
      if (pricingEnabled && unitPriceParse.error) {
        return data({ error: unitPriceParse.error }, { status: 400 });
      }
      const minPriceParse = parseBoundedNumberInput(
        formData.get("minPrice"),
        "Floor price",
        PRICE_LIMITS,
        existingField?.pricing.minPrice ?? 0,
        { allowDecimalComma: true },
      );
      if (pricingEnabled && minPriceParse.error) {
        return data({ error: minPriceParse.error }, { status: 400 });
      }
      for (const rule of dimensionRules) {
        if (!SUPPORTED_DIMENSIONS.includes(rule.dimensionType as SupportedDimensionType)) continue;
        const limits = getDimensionNumericLimits(rule.dimensionType as SupportedDimensionType);
        if (rule.value < limits.min || rule.value > limits.max) {
          return data(
            {
              error: `${dimensionLabel(rule.dimensionType as SupportedDimensionType)} rule value must be between ${limits.min} and ${limits.max}.`,
            },
            { status: 400 },
          );
        }
      }

      const planAllowsRenaming = canUseFeature(planCode, "fileRenaming");
      let resolvedFileRenamingPattern: string;
      if (planAllowsRenaming) {
        const raw = String(formData.get("fileRenamingPattern") ?? "").trim();
        resolvedFileRenamingPattern = raw ? raw.slice(0, 200) : DEFAULT_FILE_RENAME_PATTERN;
      } else if (id === "new" || !existingField) {
        resolvedFileRenamingPattern = DEFAULT_FILE_RENAME_PATTERN;
      } else {
        resolvedFileRenamingPattern = existingField.fileRenamingPattern || DEFAULT_FILE_RENAME_PATTERN;
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
        fileRenamingPattern: resolvedFileRenamingPattern,
        minFiles: 1,
        maxFiles: 1,
        allowedExtensions,
        maxFileMB,
        pricing: {
          enabled: pricingEnabled,
          unitType: pricingUnitType,
          unitPrice: unitPriceParse.value,
          minPrice: minPriceParse.value,
          roundingEnabled: parseBoolean(formData.get("roundingEnabled")),
        },
        dimensionRules,
        planRequirement: "free",
        createdAt: existingField?.createdAt || nowIso,
        updatedAt: nowIso,
      };

      await saveUploadField(session.shop, nextField);
      log.event(id === "new" ? "field_created" : "field_updated", {
        fieldId: nextField.id,
        isNew: id === "new",
      });
      return redirect(`/app/fields?toast=field_saved`);
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_field_editor_action_failed", err, {
        path: `/app/fields/${params.id || "new"}`,
      });
      throw err;
    }
  });
};

export default function FieldEditorPage() {
  const { field, isNew, shopDomain, planCode, maxFileMBFromPlan, fieldCreationBlocked, allFields } =
    useLoaderData<typeof loader>();
  const planAllowsAdvancedValidation = canUseFeature(planCode, "advancedValidation");
  const planAllowsFileRenaming = canUseFeature(planCode, "fileRenaming");
  const planAllowsDynamicPricing = canUseFeature(planCode, "dynamicPricing");
  const patternIsCustom =
    !isNew && field.fileRenamingPattern.trim() !== DEFAULT_FILE_RENAME_PATTERN;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const appBridge = useAppBridge();
  const [searchParams] = useSearchParams();

  const initialState = useMemo(() => {
    const derivedDimensionState = canUseFeature(planCode, "advancedValidation")
      ? deriveDimensionCards(field.dimensionRules)
      : {
        cards: {
          widthInch: defaultDimensionCard("widthInch"),
          heightInch: defaultDimensionCard("heightInch"),
          dpi: defaultDimensionCard("dpi"),
        } as Record<SupportedDimensionType, DimensionCard>,
        legacyRules: [] as UploadFieldDimensionRule[],
        simplifiedLegacyRules: false,
      };

    return {
      adminTitle: field.adminTitle,
      targetProducts: field.targetProducts,
      targetCollections: field.targetCollections,
      targetVariantIds: field.targetVariantIds,
      isActive: field.isActive,
      storefrontTitle: field.storefrontTitle,
      storefrontDescription: field.storefrontDescription,
      fileRenamingPattern: field.fileRenamingPattern,
      contentTypeRestricted: field.allowedExtensions.length > 0,
      allowedExtensions: field.allowedExtensions,
      maxFileMB: String(field.maxFileMB),
      pricingEnabled: field.pricing.enabled,
      pricingUnitType: field.pricing.unitType,
      unitPrice: String(field.pricing.unitPrice),
      minPrice: String(field.pricing.minPrice),
      roundingEnabled: field.pricing.roundingEnabled,
      dimensionCards: derivedDimensionState.cards,
      legacyDimensionRules: derivedDimensionState.legacyRules,
      dimensionRulesSimplified: derivedDimensionState.simplifiedLegacyRules,
    };
  }, [field, planCode]);

  const [adminTitle, setAdminTitle] = useState(initialState.adminTitle);
  const [targetProducts, setTargetProducts] = useState<FieldTargetProduct[]>(initialState.targetProducts);
  const [targetCollections, setTargetCollections] = useState<FieldTargetCollection[]>(initialState.targetCollections);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  const [targetVariantIds, setTargetVariantIds] = useState<string[]>(initialState.targetVariantIds);
  const [isActive, setIsActive] = useState(initialState.isActive);
  const [storefrontTitle, setStorefrontTitle] = useState(initialState.storefrontTitle);
  const [storefrontDescription, setStorefrontDescription] = useState(initialState.storefrontDescription);
  const [fileRenamingPattern, setFileRenamingPattern] = useState(initialState.fileRenamingPattern);
  const [contentTypeRestricted, setContentTypeRestricted] = useState(initialState.contentTypeRestricted);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>(initialState.allowedExtensions);
  const [newExtension, setNewExtension] = useState("");
  const [maxFileMB, setMaxFileMB] = useState(initialState.maxFileMB);
  const [pricingEnabled, setPricingEnabled] = useState(
    planAllowsDynamicPricing ? initialState.pricingEnabled : false,
  );
  const [pricingUnitType, setPricingUnitType] = useState(initialState.pricingUnitType);
  const [unitPrice, setUnitPrice] = useState(initialState.unitPrice);
  const [minPrice, setMinPrice] = useState(initialState.minPrice);
  const [renameHelpOpen, setRenameHelpOpen] = useState(false);
  const [dimensionCards, setDimensionCards] = useState(initialState.dimensionCards);
  const [legacyDimensionRules, setLegacyDimensionRules] = useState<UploadFieldDimensionRule[]>(
    initialState.legacyDimensionRules,
  );
  const [dimensionRulesSimplified, setDimensionRulesSimplified] = useState(
    initialState.dimensionRulesSimplified,
  );

  const targetOverlapFromEditor = useMemo(() => {
    const current = fieldWithEditorTargets(field, isActive, targetProducts, targetCollections);
    const mergedList = isNew
      ? [...allFields, current]
      : allFields.map((f) => (f.id === field.id ? current : f));
    return {
      analysis: analyzeActiveFieldTargetOverlaps(mergedList),
      thisFieldOverlaps: activeFieldParticipatesInTargetOverlap(current, mergedList),
    };
  }, [allFields, field, isNew, isActive, targetProducts, targetCollections]);

  const renamePreviewExample = useMemo(() => {
    const pattern = planAllowsFileRenaming
      ? fileRenamingPattern
      : patternIsCustom
        ? field.fileRenamingPattern
        : DEFAULT_FILE_RENAME_PATTERN;
    return previewRenamedFileName(pattern);
  }, [planAllowsFileRenaming, fileRenamingPattern, patternIsCustom, field.fileRenamingPattern]);

  const renameTokensHelp = (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{orderId}`}</Text> — Shopify order ID (numeric).
        </Text>
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{orderName}`}</Text> — Order name (e.g. #1001).
        </Text>
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{lineItemId}`}</Text> — Line item ID.
        </Text>
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{variantName}`}</Text> — Variant title.
        </Text>
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{originalName}`}</Text> — File name without extension.
        </Text>
        <Text as="p" variant="bodySm">
          <Text as="span" fontWeight="semibold">{`{fileIndex}`}</Text> — 1-based index when multiple files.
        </Text>
      </BlockStack>
    </Card>
  );

  const dirtyComparableCurrent = {
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
    pricingEnabled,
    pricingUnitType,
    unitPrice,
    minPrice,
    roundingEnabled: initialState.roundingEnabled,
    dimensionCards,
    legacyDimensionRules,
    dimensionRulesSimplified,
  };
  const dirtyComparableInitial = {
    adminTitle: initialState.adminTitle,
    targetProducts: initialState.targetProducts,
    targetCollections: initialState.targetCollections,
    targetVariantIds: initialState.targetVariantIds,
    isActive: initialState.isActive,
    storefrontTitle: initialState.storefrontTitle,
    storefrontDescription: initialState.storefrontDescription,
    fileRenamingPattern: initialState.fileRenamingPattern,
    contentTypeRestricted: initialState.contentTypeRestricted,
    allowedExtensions: initialState.allowedExtensions,
    maxFileMB: initialState.maxFileMB,
    pricingEnabled: initialState.pricingEnabled,
    pricingUnitType: initialState.pricingUnitType,
    unitPrice: initialState.unitPrice,
    minPrice: initialState.minPrice,
    roundingEnabled: initialState.roundingEnabled,
    dimensionCards: initialState.dimensionCards,
    legacyDimensionRules: initialState.legacyDimensionRules,
    dimensionRulesSimplified: initialState.dimensionRulesSimplified,
  };
  const serializedCurrent = JSON.stringify(dirtyComparableCurrent);
  const serializedInitial = JSON.stringify(dirtyComparableInitial);
  const isDirty = serializedCurrent !== serializedInitial;

  const resetForm = useCallback(() => {
    setAdminTitle(initialState.adminTitle);
    setTargetProducts(initialState.targetProducts);
    setTargetCollections(initialState.targetCollections);
    setTargetVariantIds(initialState.targetVariantIds);
    setIsActive(initialState.isActive);
    setStorefrontTitle(initialState.storefrontTitle);
    setStorefrontDescription(initialState.storefrontDescription);
    setFileRenamingPattern(initialState.fileRenamingPattern);
    setContentTypeRestricted(initialState.contentTypeRestricted);
    setAllowedExtensions(initialState.allowedExtensions);
    setMaxFileMB(initialState.maxFileMB);
    setPricingEnabled(planAllowsDynamicPricing ? initialState.pricingEnabled : false);
    setPricingUnitType(initialState.pricingUnitType);
    setUnitPrice(initialState.unitPrice);
    setMinPrice(initialState.minPrice);
    setDimensionCards(initialState.dimensionCards);
    setLegacyDimensionRules(initialState.legacyDimensionRules);
    setDimensionRulesSimplified(initialState.dimensionRulesSimplified);
  }, [initialState, planAllowsDynamicPricing]);

  const applyProductPickerSelection = useCallback((selection: FieldTargetProduct[]) => {
    setTargetProducts((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      for (const product of selection) {
        byId.set(product.id, product);
      }
      return Array.from(byId.values());
    });
    setProductPickerOpen(false);
  }, []);

  const applyCollectionPickerSelection = useCallback((selection: FieldTargetCollection[]) => {
    setTargetCollections((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      for (const collection of selection) {
        byId.set(collection.id, collection);
      }
      return Array.from(byId.values());
    });
    setCollectionPickerOpen(false);
  }, []);

  const removeProduct = useCallback((id: string) => {
    setTargetProducts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const removeCollection = useCallback((id: string) => {
    setTargetCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // `useNewValueEffect` prevents the error toast from re-firing on every
  // re-render while `actionData.error` stays truthy, and makes the
  // ?toast=duplicated notification fire exactly once on arrival.
  useNewValueEffect(actionData, (value) => {
    if ("error" in value && value.error) {
      appBridge.toast.show(value.error, { isError: true });
    }
  });

  useNewValueEffect(searchParams.get("toast"), (value) => {
    if (value === "duplicated") appBridge.toast.show("Field duplicated");
  });

  const pageTitle = isNew ? "Create Field" : (adminTitle || "Edit Field");
  const hasTargets = targetProducts.length > 0 || targetCollections.length > 0;
  const firstProductHandle = targetProducts[0]?.handle;
  const isSaving = navigation.state === "submitting";
  const showMinPrice = pricingUnitType === "inch_height" || pricingUnitType === "inch_square";
  const allowedDimensionTypes = allowedDimensionTypesForMethod(pricingUnitType) as SupportedDimensionType[];
  const serializedDimensionRules = useMemo(
    () => serializeDimensionCards(dimensionCards, allowedDimensionTypes, legacyDimensionRules),
    [allowedDimensionTypes, dimensionCards, legacyDimensionRules],
  );
  const dimensionCardErrors = useMemo(() => {
    const errors: Partial<Record<SupportedDimensionType, string>> = {};
    for (const dimensionType of allowedDimensionTypes) {
      const card = dimensionCards[dimensionType];
      if (!card || card.mode === "off") continue;
      if (card.mode === "fixed") {
        if (inputToFiniteNumber(card.fixedValue) === null) {
          errors[dimensionType] = "Enter a valid fixed value.";
        }
        continue;
      }

      const minValue = inputToFiniteNumber(card.rangeMin);
      const maxValue = inputToFiniteNumber(card.rangeMax);
      if (minValue === null && maxValue === null) {
        errors[dimensionType] = "Enter at least a min or max value.";
      } else if (minValue !== null && maxValue !== null && minValue > maxValue) {
        errors[dimensionType] = "Min must be less than or equal to max.";
      }
    }
    return errors;
  }, [allowedDimensionTypes, dimensionCards]);

  const handleSave = useCallback(() => {
    if (fieldCreationBlocked || isSaving) return;
    const form = document.getElementById("field-editor-form") as HTMLFormElement | null;
    form?.requestSubmit();
  }, [fieldCreationBlocked, isSaving]);

  const handleDiscard = useCallback(() => {
    if (isSaving) return;
    if (isNew) {
      navigate("/app/fields");
      return;
    }
    resetForm();
  }, [isSaving, isNew, navigate, resetForm]);

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
      <style>
        {`
          .field-editor-form-content {
            padding-bottom: ${isDirty ? "88px" : "0"};
          }
          .field-editor-sticky-actions {
            position: sticky;
            bottom: 0;
            z-index: 30;
            margin-top: 16px;
            padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
            border-top: 1px solid var(--p-border-subdued, #dfe3e8);
            background: var(--p-color-bg-surface, #ffffff);
            box-shadow: 0 -6px 12px rgba(0, 0, 0, 0.06);
          }
        `}
      </style>
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
        <input type="hidden" name="dimensionRules" value={JSON.stringify(serializedDimensionRules)} />
        <input type="hidden" name="isActive" value={isActive ? "true" : "false"} />

        <div className="field-editor-form-content">
          <BlockStack gap="400">
          {fieldCreationBlocked ? (
            <Banner
              tone="warning"
              title="Field limit reached"
              action={{ content: "View plans", url: "/app/plans" }}
            >
              {merchantUpgradeHint("moreUploadFields")}
            </Banner>
          ) : null}
          {targetOverlapFromEditor.analysis.hasOverlap ? (
            <Banner tone="info" title="Some products or collections are covered by more than one active field">
              <FieldTargetOverlapBannerContent
                analysis={targetOverlapFromEditor.analysis}
                thisFieldOverlaps={targetOverlapFromEditor.thisFieldOverlaps}
              />
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
                <Checkbox
                  label="Active"
                  checked={isActive}
                  onChange={() => setIsActive((prev) => !prev)}
                />
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
                  <Button onClick={() => setProductPickerOpen(true)}>Browse products</Button>
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
                  <Button onClick={() => setCollectionPickerOpen(true)}>Browse collections</Button>
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
                {planAllowsFileRenaming ? (
                  <BlockStack gap="200">
                    <TextField
                      label="File rename pattern"
                      name="fileRenamingPattern"
                      autoComplete="off"
                      value={fileRenamingPattern}
                      onChange={setFileRenamingPattern}
                      helpText="Applied when an order is placed. Characters are sanitized for safe file names."
                      connectedRight={
                        <Popover
                          active={renameHelpOpen}
                          onClose={() => setRenameHelpOpen(false)}
                          activator={<Button onClick={() => setRenameHelpOpen(true)}>Tokens</Button>}
                        >
                          {renameTokensHelp}
                        </Popover>
                      }
                    />
                    <Text as="p" tone="subdued" variant="bodySm">
                      Example file name: {renamePreviewExample}
                    </Text>
                  </BlockStack>
                ) : patternIsCustom ? (
                  <BlockStack gap="300">
                    <Banner tone="info" title="Your custom pattern is still in use">
                      <p>
                        When customers check out, files are still renamed using the pattern below. File
                        renaming on Starter and higher plans lets you edit this pattern any time and use
                        placeholders (tokens) for order ID, line item, variant, and more. On your current
                        plan the pattern is read-only so nothing breaks for orders already using it—upgrade
                        when you are ready to customize it again.
                      </p>
                    </Banner>
                    <Button url="/app/plans" variant="primary">
                      Upgrade to {planDisplayName(suggestUpgradeFor("fileRenaming"))}
                    </Button>
                    <TextField
                      label="File rename pattern"
                      autoComplete="off"
                      value={field.fileRenamingPattern}
                      disabled
                      helpText="Applied when an order is placed."
                      connectedRight={
                        <Popover
                          active={renameHelpOpen}
                          onClose={() => setRenameHelpOpen(false)}
                          activator={<Button onClick={() => setRenameHelpOpen(true)}>Tokens</Button>}
                        >
                          {renameTokensHelp}
                        </Popover>
                      }
                    />
                    <Text as="p" tone="subdued" variant="bodySm">
                      Example file name: {renamePreviewExample}
                    </Text>
                  </BlockStack>
                ) : (
                  <BlockStack gap="300">
                    <Banner tone="info" title="Custom file names are a paid feature">
                      <p>
                        On your current plan, PrintDock uses a single default pattern for files attached to
                        orders so names stay safe and consistent. Upgrading unlocks a custom rename pattern:
                        you choose how filenames are built using tokens (for example order ID, line item,
                        and original upload name), which helps production, downloads, and archive searches
                        match how your team works.
                      </p>
                    </Banner>
                    <Button url="/app/plans" variant="primary">
                      Upgrade to {planDisplayName(suggestUpgradeFor("fileRenaming"))}
                    </Button>
                    <BlockStack gap="200">
                      <Text as="p" tone="subdued">
                        Default pattern on your plan:{" "}
                        <Text as="span" variant="bodySm">
                          {DEFAULT_FILE_RENAME_PATTERN}
                        </Text>
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Example file name: {renamePreviewExample}
                      </Text>
                    </BlockStack>
                  </BlockStack>
                )}
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
                File Size Rules
              </Text>
              <FormLayout>
                <TextField
                  name="maxFileMB"
                  label="Max file size"
                  type="text"
                  inputMode="decimal"
                  suffix="MB"
                  autoComplete="off"
                  value={maxFileMB}
                  onChange={setMaxFileMB}
                  min={FILE_SIZE_LIMITS.min}
                  max={maxFileMBFromPlan}
                  step={FILE_SIZE_LIMITS.step}
                  helpText={`Your plan allows up to ${maxFileMBFromPlan}MB`}
                />
                {Number(maxFileMB) > maxFileMBFromPlan && (
                  <Banner
                    title="File size exceeds your plan limit"
                    tone="warning"
                    action={{
                      content: `Upgrade to ${planDisplayName(suggestUpgradeFor(fileSizeUpgradeReason(planCode)))}`,
                      url: "/app/plans",
                    }}
                  >
                    {merchantUpgradeHint(fileSizeUpgradeReason(planCode))} Your current plan allows up
                    to {maxFileMBFromPlan}MB per file.
                  </Banner>
                )}
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

              <input
                type="hidden"
                name="pricingEnabled"
                value={planAllowsDynamicPricing && pricingEnabled ? "true" : "false"}
              />

              {!planAllowsDynamicPricing ? (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <Text as="p" variant="bodyMd">
                      {merchantUpgradeHint("dynamicPricing")}
                    </Text>
                    <Button url="/app/plans" variant="primary">
                      Upgrade to {planDisplayName(suggestUpgradeFor("dynamicPricing"))}
                    </Button>
                  </BlockStack>
                </Box>
              ) : (
                <>
                  <Checkbox
                    label="Charge using dynamic pricing"
                    helpText="When off, no upload fee is added from this field."
                    checked={pricingEnabled}
                    onChange={() => setPricingEnabled((prev) => !prev)}
                  />

                  {!pricingEnabled ? (
                    <>
                      <input type="hidden" name="pricingUnitType" value={pricingUnitType} />
                      <input type="hidden" name="unitPrice" value={unitPrice} />
                      <input type="hidden" name="minPrice" value={minPrice} />
                      <input type="hidden" name="roundingEnabled" value="false" />
                    </>
                  ) : null}

                  {!pricingEnabled ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Turn on dynamic pricing to set how the upload fee is calculated.
                    </Text>
                  ) : null}

                  {pricingEnabled ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Rate settings
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {
                          "These values are calculated directly from the uploaded file metadata (no inferred DPI or roll width fallback)."
                        }
                      </Text>
                      {!showMinPrice ? <input type="hidden" name="minPrice" value={minPrice} /> : null}
                      <FormLayout>
                        <Select
                          name="pricingUnitType"
                          label="Calculation method"
                          helpText="Pick how the fee scales with the uploaded file."
                          value={pricingUnitType}
                          options={[
                            { label: "Flat — fixed price per upload", value: "flat" },
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
                              label={unitPriceLabelForMethod(pricingUnitType)}
                              type="text"
                              inputMode="decimal"
                              prefix="$"
                              autoComplete="off"
                              value={unitPrice}
                              onChange={setUnitPrice}
                              helpText="Used by the selected calculation method. Decimal comma is accepted."
                            />
                          </Box>
                          {showMinPrice ? (
                            <Box minWidth="200px" width="100%">
                              <TextField
                                name="minPrice"
                                label="Floor price"
                                type="text"
                                inputMode="decimal"
                                prefix="$"
                                autoComplete="off"
                                value={minPrice}
                                onChange={setMinPrice}
                                helpText="Minimum fee charged for an upload (0 = no floor). Decimal comma is accepted."
                              />
                            </Box>
                          ) : null}
                        </InlineStack>
                        <input type="hidden" name="roundingEnabled" value="false" />
                      </FormLayout>
                    </BlockStack>
                  ) : null}
                </>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <BlockStack gap="150">
                <Text as="h2" variant="headingMd">
                  Dimension rules
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Block uploads when artwork does not meet the size or DPI limits you define.
                  Customers will see the exact reason with their file&apos;s measured value.
                </Text>
              </BlockStack>

              {planAllowsAdvancedValidation ? (
                <BlockStack gap="300">
                  <Banner tone="info" title="How file dimensions are measured">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm">
                        We read DPI directly from <Text as="span" fontWeight="semibold">PNG (pHYs chunk)</Text>
                        {" "}and <Text as="span" fontWeight="semibold">JPEG (JFIF density tag)</Text>. PDFs
                        report a fixed 72 DPI per spec.
                      </Text>
                      <Text as="p" variant="bodySm">
                        Files that only carry DPI in JPEG EXIF (the default for many Photoshop /
                        Lightroom / camera exports) are treated as <Text as="span" fontWeight="semibold">missing DPI</Text>
                        {" "}— customers will see a clear message and can re-export with embedded DPI.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Reported densities below 30 DPI are also treated as missing, because most
                        tools write that as a placeholder when no real DPI is set.
                      </Text>
                    </BlockStack>
                  </Banner>
                  {dimensionRulesSimplified ? (
                    <Banner tone="info" title="Previous rules were simplified">
                      Existing operator-based rules were converted into the nearest fixed or range
                      rule for this editor. Save to keep the simplified structure.
                    </Banner>
                  ) : null}
                  {allowedDimensionTypes.map((dimensionType) => {
                    const card = dimensionCards[dimensionType];
                    const cardError = dimensionCardErrors[dimensionType];
                    const modeSelection = [card.mode];

                    return (
                      <Box
                        key={dimensionType}
                        padding="300"
                        borderWidth="025"
                        borderRadius="200"
                        borderColor="border"
                      >
                        <BlockStack gap="300">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">
                              {dimensionLabel(dimensionType)}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {dimensionType === "dpi"
                                ? "Set an exact DPI target or an accepted DPI range."
                                : `Set an exact ${dimensionLabel(dimensionType).toLowerCase()} or an accepted range in inches.`}
                            </Text>
                          </BlockStack>
                          <ChoiceList
                            title="Validation mode"
                            titleHidden
                            choices={[
                              { label: "Off", value: "off" },
                              { label: "Fixed value", value: "fixed" },
                              { label: "Range", value: "range" },
                            ]}
                            selected={modeSelection}
                            onChange={(selected) => {
                              const mode = (selected[0] ?? "off") as DimensionRuleMode;
                              setDimensionCards((prev) => ({
                                ...prev,
                                [dimensionType]: {
                                  ...prev[dimensionType],
                                  mode,
                                  groupId: prev[dimensionType].groupId || crypto.randomUUID(),
                                },
                              }));
                            }}
                          />
                          {card.mode === "fixed" ? (
                            <TextField
                              label={`${dimensionLabel(dimensionType)} value`}
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              value={card.fixedValue}
                              suffix={dimensionSuffix(dimensionType)}
                              min={getDimensionNumericLimits(dimensionType).min}
                              max={getDimensionNumericLimits(dimensionType).max}
                              step={getDimensionNumericLimits(dimensionType).step}
                              onChange={(value) =>
                                setDimensionCards((prev) => ({
                                  ...prev,
                                  [dimensionType]: { ...prev[dimensionType], fixedValue: value },
                                }))
                              }
                              helpText={
                                dimensionType === "dpi"
                                  ? "Files must report exactly this DPI."
                                  : "Files must measure exactly this value (rounded to 0.01 in)."
                              }
                              error={card.mode === "fixed" ? cardError : undefined}
                            />
                          ) : null}
                          {card.mode === "range" ? (
                            <InlineStack gap="300" wrap>
                              <div style={{ minWidth: 180, width: "100%" }}>
                                <TextField
                                  label="Min"
                                  type="text"
                                  inputMode="decimal"
                                  autoComplete="off"
                                  value={card.rangeMin}
                                  suffix={dimensionSuffix(dimensionType)}
                                  min={getDimensionNumericLimits(dimensionType).min}
                                  max={getDimensionNumericLimits(dimensionType).max}
                                  step={getDimensionNumericLimits(dimensionType).step}
                                  onChange={(value) =>
                                    setDimensionCards((prev) => ({
                                      ...prev,
                                      [dimensionType]: { ...prev[dimensionType], rangeMin: value },
                                    }))
                                  }
                                />
                              </div>
                              <div style={{ minWidth: 180, width: "100%" }}>
                                <TextField
                                  label="Max"
                                  type="text"
                                  inputMode="decimal"
                                  autoComplete="off"
                                  value={card.rangeMax}
                                  suffix={dimensionSuffix(dimensionType)}
                                  min={getDimensionNumericLimits(dimensionType).min}
                                  max={getDimensionNumericLimits(dimensionType).max}
                                  step={getDimensionNumericLimits(dimensionType).step}
                                  onChange={(value) =>
                                    setDimensionCards((prev) => ({
                                      ...prev,
                                      [dimensionType]: { ...prev[dimensionType], rangeMax: value },
                                    }))
                                  }
                                />
                              </div>
                            </InlineStack>
                          ) : null}
                          {card.mode === "range" && cardError ? (
                            <Text as="p" variant="bodySm" tone="critical">
                              {cardError}
                            </Text>
                          ) : null}
                          {dimensionType === "dpi" ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              PDFs are evaluated at their native 72 DPI. Raster images use embedded DPI metadata.
                            </Text>
                          ) : null}
                        </BlockStack>
                      </Box>
                    );
                  })}
                  {legacyDimensionRules.length > 0 ? (
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Legacy rules (read-only)
                      </Text>
                      {legacyDimensionRules.map((rule, index) => (
                        <InlineStack key={rule.id || `${rule.dimensionType}-${index}`} align="space-between">
                          <Text as="p" tone="subdued" variant="bodySm">
                            {`${rule.dimensionType} ${rule.operator} ${rule.value}`}
                          </Text>
                          <Button
                            tone="critical"
                            onClick={() =>
                              setLegacyDimensionRules((prev) =>
                                prev.filter((_, ruleIndex) => ruleIndex !== index),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : null}
                </BlockStack>
              ) : (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <Text as="p" variant="bodyMd">
                      {merchantUpgradeHint("advancedValidation")}
                    </Text>
                    <Button url="/app/plans" variant="primary">
                      Upgrade to {planDisplayName(suggestUpgradeFor("advancedValidation"))}
                    </Button>
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Card>

          {firstProductHandle ? (
            <Card>
              <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
                <Text as="p" variant="bodySm" tone="subdued">
                  Open the storefront product page to see how this field appears to customers.
                </Text>
                <Button url={`https://${shopDomain}/products/${firstProductHandle}`} target="_blank">
                  Preview product
                </Button>
              </InlineStack>
            </Card>
          ) : null}
          </BlockStack>
        </div>
        {isDirty ? (
          <div className="field-editor-sticky-actions">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <Text as="p" variant="bodySm" tone="subdued">
                Unsaved changes
              </Text>
              <InlineStack gap="200">
                <Button onClick={handleDiscard} disabled={isSaving}>
                  Discard
                </Button>
                <Button onClick={handleSave} variant="primary" loading={isSaving} disabled={fieldCreationBlocked || isSaving}>
                  Save field
                </Button>
              </InlineStack>
            </InlineStack>
          </div>
        ) : null}
      </Form>

      <TargetResourcePickerModal
        kind="product"
        open={productPickerOpen}
        initialSelection={targetProducts}
        onClose={() => setProductPickerOpen(false)}
        onConfirm={(selection) => applyProductPickerSelection(selection as FieldTargetProduct[])}
      />
      <TargetResourcePickerModal
        kind="collection"
        open={collectionPickerOpen}
        initialSelection={targetCollections}
        onClose={() => setCollectionPickerOpen(false)}
        onConfirm={(selection) => applyCollectionPickerSelection(selection as FieldTargetCollection[])}
      />
    </Page>
  );
}
