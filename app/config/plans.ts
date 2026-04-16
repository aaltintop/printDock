export type PlanCode = "free" | "starter" | "pro" | "business";

export interface PlanLimits {
  planCode: PlanCode;
  displayName: string;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
  trialDays: number;
  maxFileSizeBytes: number;
  maxOrdersPerMonth: number;
  maxUploadFields: number;
  fileStorageDays: number;
  advancedValidation: boolean;
  fileRenaming: boolean;
  bulkDownload: boolean;
  dynamicPricing: boolean;
}

export const PLANS: Record<PlanCode, PlanLimits> = {
  free: {
    planCode: "free",
    displayName: "Free",
    monthlyPriceUsd: 0,
    yearlyPriceUsd: 0,
    trialDays: 0,
    maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
    maxOrdersPerMonth: 10,
    maxUploadFields: 2,
    fileStorageDays: 7,
    advancedValidation: false,
    fileRenaming: false,
    bulkDownload: false,
    dynamicPricing: false,
  },
  starter: {
    planCode: "starter",
    displayName: "Starter",
    monthlyPriceUsd: 9,
    yearlyPriceUsd: 86,
    trialDays: 7,
    maxFileSizeBytes: 300 * 1024 * 1024, // 300 MB
    maxOrdersPerMonth: 50,
    maxUploadFields: -1,
    fileStorageDays: 7,
    advancedValidation: true,
    fileRenaming: true,
    bulkDownload: false,
    dynamicPricing: false,
  },
  pro: {
    planCode: "pro",
    displayName: "Pro",
    monthlyPriceUsd: 19,
    yearlyPriceUsd: 182,
    trialDays: 7,
    maxFileSizeBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    maxOrdersPerMonth: 500,
    maxUploadFields: -1,
    fileStorageDays: 7,
    advancedValidation: true,
    fileRenaming: true,
    bulkDownload: true,
    dynamicPricing: true,
  },
  business: {
    planCode: "business",
    displayName: "Business",
    monthlyPriceUsd: 49,
    yearlyPriceUsd: 490,
    trialDays: 7,
    maxFileSizeBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    maxOrdersPerMonth: -1,
    maxUploadFields: -1,
    fileStorageDays: 30,
    advancedValidation: true,
    fileRenaming: true,
    bulkDownload: true,
    dynamicPricing: true,
  },
};

export const PLAN_SUBSCRIPTION_NAMES: Record<
  Exclude<PlanCode, "free">,
  string
> = {
  starter: "PrintDock Starter",
  pro: "PrintDock Pro",
  business: "PrintDock Business",
};

type BooleanFeature = keyof Pick<
  PlanLimits,
  "advancedValidation" | "fileRenaming" | "bulkDownload" | "dynamicPricing"
>;

export function getPlan(planCode: PlanCode): PlanLimits {
  return PLANS[planCode] ?? PLANS["free"];
}

export function canUseFeature(
  planCode: PlanCode,
  feature: BooleanFeature,
): boolean {
  return getPlan(planCode)[feature];
}

export function isWithinOrderLimit(
  planCode: PlanCode,
  currentMonthOrders: number,
): boolean {
  const limit = getPlan(planCode).maxOrdersPerMonth;
  return limit === -1 || currentMonthOrders < limit;
}

export function isWithinFieldLimit(
  planCode: PlanCode,
  currentFieldCount: number,
): boolean {
  const limit = getPlan(planCode).maxUploadFields;
  return limit === -1 || currentFieldCount < limit;
}

export function isFileSizeAllowed(
  planCode: PlanCode,
  fileSizeBytes: number,
): boolean {
  return fileSizeBytes <= getPlan(planCode).maxFileSizeBytes;
}

/**
 * Maps old plan codes from Firestore to current plan codes.
 * Existing merchants may have basic_plus or pro_plus stored.
 */
const LEGACY_PLAN_MAP: Record<string, PlanCode> = {
  basic_plus: "starter",
  pro_plus: "business",
};

export function migratePlanCode(raw: string): PlanCode {
  if (raw in PLANS) return raw as PlanCode;
  return LEGACY_PLAN_MAP[raw] ?? "free";
}

export function planCodeFromSubscriptionName(name: string): PlanCode {
  const normalized = name.toLowerCase();
  for (const [code, subName] of Object.entries(PLAN_SUBSCRIPTION_NAMES)) {
    if (normalized === subName.toLowerCase()) return code as PlanCode;
  }
  return "free";
}
