import {
  canUseFeature,
  planDisplayName,
  suggestUpgradeFor,
  type PlanCode,
} from "../config/plans";
import type { UploadFieldConfig } from "../types/printdock";

export type DynamicPricingPlanMismatch = {
  /** Fields with `pricing.enabled` while the shop plan disallows dynamic pricing. */
  fields: Array<{ id: string; adminTitle: string }>;
  planCode: PlanCode;
  upgradePlanName: string;
};

/**
 * Merchants can downgrade or stay on Free/Starter while Firestore still has
 * `pricing.enabled: true` from an earlier Pro edit. Storefront config strips
 * pricing at runtime, so checkout silently skips upload fees — easy to miss.
 */
export function getDynamicPricingPlanMismatch(
  fields: UploadFieldConfig[],
  planCode: PlanCode,
): DynamicPricingPlanMismatch | null {
  if (canUseFeature(planCode, "dynamicPricing")) {
    return null;
  }
  const mismatched = fields
    .filter((field) => Boolean(field.pricing?.enabled))
    .map((field) => ({ id: field.id, adminTitle: field.adminTitle || "Untitled field" }));
  if (mismatched.length === 0) {
    return null;
  }
  return {
    fields: mismatched,
    planCode,
    upgradePlanName: planDisplayName(suggestUpgradeFor("dynamicPricing")),
  };
}
