export type PlanCode = "free" | "starter" | "pro" | "business";

/** Reasons for upgrade prompts (maps to spec Feature Gate / UI Upgrade Prompt table). */
export type UpgradeReason =
  | "moreUploadFields"
  | "advancedValidation"
  | "fileRenaming"
  | "fileSize_gt50mb"
  | "totalStorage_gt500mb"
  | "dynamicPricing"
  | "fileStorage_gt7days"
  | "fileSize_gt300mb"
  | "totalStorage_gt15gb"
  | "fileSize_gt1gb"
  | "totalStorage_gt30gb";

export interface PlanLimits {
  planCode: PlanCode;
  displayName: string;
  maxFileSizeBytes: number;
  maxUploadFields: number;
  fileStorageDays: number;
  /** Total upload storage cap for the shop (bytes). */
  maxTotalStorageBytes: number;
  basicValidation: boolean; // file type, size, count — always true for all plans
  advancedValidation: boolean;
  fileRenaming: boolean;
  dynamicPricing: boolean;
}

export const PLANS: Record<PlanCode, PlanLimits> = {
  // basicValidation (file type/MIME/count) is always enforced regardless of plan
  // advancedValidation adds: DPI checks, pixel dimensions, PDF page count, print size
  free: {
    planCode: "free",
    displayName: "Free",
    maxFileSizeBytes: 52_428_800, // 50 MB
    maxUploadFields: 2,
    fileStorageDays: 7,
    maxTotalStorageBytes: 524_288_000, // 500 MB
    basicValidation: true,
    advancedValidation: false,
    fileRenaming: false,
    dynamicPricing: true,
  },
  starter: {
    planCode: "starter",
    displayName: "Starter",
    maxFileSizeBytes: 314_572_800, // 300 MB
    maxUploadFields: -1,
    fileStorageDays: 7,
    maxTotalStorageBytes: 16_106_127_360, // 15 GB
    basicValidation: true,
    advancedValidation: true,
    fileRenaming: true,
    dynamicPricing: true,
  },
  pro: {
    planCode: "pro",
    displayName: "Pro",
    maxFileSizeBytes: 1_073_741_824, // 1 GB
    maxUploadFields: -1,
    fileStorageDays: 30,
    maxTotalStorageBytes: 32_212_254_720, // 30 GB
    basicValidation: true,
    advancedValidation: true,
    fileRenaming: true,
    dynamicPricing: true,
  },
  business: {
    planCode: "business",
    displayName: "Business",
    maxFileSizeBytes: 5_368_709_120, // 5 GB
    maxUploadFields: -1,
    fileStorageDays: 30,
    maxTotalStorageBytes: 80_530_636_800, // 75 GB
    basicValidation: true,
    advancedValidation: true,
    fileRenaming: true,
    dynamicPricing: true,
  },
};

/**
 * Canonical names as returned by Shopify Managed Pricing / webhooks (after normalization).
 * `planCodeFromSubscriptionName` also accepts optional `PrintDock ` prefix and monthly/yearly suffixes.
 */
export const PLAN_SUBSCRIPTION_NAMES: Record<PlanCode, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
};

/** Strips optional frequency suffix from managed-pricing plan titles, e.g. "Pro Monthly". */
const SUBSCRIPTION_NAME_FREQUENCY_SUFFIX =
  /\s*(monthly|yearly|annual|annually|per\s+month|per\s+year)$/i;

function normalizeSubscriptionNameForMatch(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^printdock\s+/, "")
    .replace(SUBSCRIPTION_NAME_FREQUENCY_SUFFIX, "")
    .trim();
}

/** True if the subscription title matches a known plan name after the same normalization as {@link planCodeFromSubscriptionName}. */
export function isRecognizedSubscriptionName(name: string): boolean {
  const normalized = normalizeSubscriptionNameForMatch(name);
  for (const subName of Object.values(PLAN_SUBSCRIPTION_NAMES)) {
    if (normalized === subName.toLowerCase()) return true;
  }
  return false;
}

type BooleanFeature = keyof Pick<
  PlanLimits,
  | "basicValidation"
  | "advancedValidation"
  | "fileRenaming"
  | "dynamicPricing"
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

export function isWithinTotalStorage(
  planCode: PlanCode,
  currentBytes: number,
  incomingBytes: number,
): boolean {
  const cap = getPlan(planCode).maxTotalStorageBytes;
  return currentBytes + incomingBytes <= cap;
}

/**
 * Which paid plan unlocks this limitation (spec UI Upgrade Prompt Rules).
 */
export function suggestUpgradeFor(reason: UpgradeReason): PlanCode {
  switch (reason) {
    case "moreUploadFields":
    case "advancedValidation":
    case "fileRenaming":
    case "fileSize_gt50mb":
    case "totalStorage_gt500mb":
      return "starter";
    case "dynamicPricing":
    case "fileStorage_gt7days":
    case "fileSize_gt300mb":
    case "totalStorage_gt15gb":
      return "pro";
    case "fileSize_gt1gb":
    case "totalStorage_gt30gb":
      return "business";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Human-readable plan name for upgrade CTAs. */
export function planDisplayName(planCode: PlanCode): string {
  return getPlan(planCode).displayName;
}

/** Merchant-facing upgrade sentence (links go to `/app/plans` in UI). */
export function merchantUpgradeHint(reason: UpgradeReason): string {
  const target = planDisplayName(suggestUpgradeFor(reason));
  const lines: Record<UpgradeReason, string> = {
    moreUploadFields: `Upgrade to ${target} to add more upload fields.`,
    advancedValidation: `Upgrade to ${target} to use advanced file validation (dimensions, DPI, page count).`,
    fileRenaming: `Upgrade to ${target} to use custom file renaming patterns.`,
    fileSize_gt50mb: `Upgrade to ${target} for a higher per-file size limit.`,
    totalStorage_gt500mb: `Upgrade to ${target} for more total upload storage.`,
    dynamicPricing: `Upgrade to ${target} to use dynamic price calculation.`,
    fileStorage_gt7days: `Upgrade to ${target} for longer file retention.`,
    fileSize_gt300mb: `Upgrade to ${target} for a higher per-file size limit.`,
    totalStorage_gt15gb: `Upgrade to ${target} for more total upload storage.`,
    fileSize_gt1gb: `Upgrade to ${target} for a higher per-file size limit.`,
    totalStorage_gt30gb: `Upgrade to ${target} for more total upload storage.`,
  };
  return lines[reason];
}

/** Map current plan to the per-file upgrade reason when the user raises max file MB. */
export function fileSizeUpgradeReason(currentPlan: PlanCode): UpgradeReason {
  switch (currentPlan) {
    case "free":
      return "fileSize_gt50mb";
    case "starter":
      return "fileSize_gt300mb";
    case "pro":
      return "fileSize_gt1gb";
    case "business":
      return "fileSize_gt1gb";
  }
}

/** Reason key for total-storage cap (depends on current plan tier). */
export function storageOverageUpgradeReason(planCode: PlanCode): UpgradeReason {
  switch (planCode) {
    case "free":
      return "totalStorage_gt500mb";
    case "starter":
      return "totalStorage_gt15gb";
    case "pro":
      return "totalStorage_gt30gb";
    case "business":
      return "totalStorage_gt30gb";
  }
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
  const normalized = normalizeSubscriptionNameForMatch(name);
  for (const [code, subName] of Object.entries(PLAN_SUBSCRIPTION_NAMES)) {
    if (normalized === subName.toLowerCase()) return code as PlanCode;
  }
  return "free";
}
