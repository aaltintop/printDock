import type { BillingPlan } from "../types/printdock";

/** Hours to keep admin access when Shopify reports FROZEN / ON_HOLD. */
export const BILLING_FROZEN_GRACE_HOURS = 72;

/**
 * Routes merchants may open while billing is locked (no active subscription).
 * Must include `/app/plans` so they can open Managed Pricing.
 */
export function isPathExemptFromBillingRedirect(pathname: string): boolean {
  if (pathname === "/app/plans" || pathname.startsWith("/app/plans/")) return true;
  if (pathname === "/app/release-notes" || pathname.startsWith("/app/release-notes/")) return true;
  if (pathname === "/app/glossary" || pathname.startsWith("/app/glossary/")) return true;
  return false;
}

/**
 * True when the shop may use the embedded admin under the billing gate.
 * Does **not** mean "paid" — an explicitly selected Free plan with status active qualifies.
 * PENDING Shopify charges (`trial` + subscriptionId) are allowed so approval can complete.
 */
export function hasActiveSubscription(plan: BillingPlan): boolean {
  if (plan.source === "dev_override" || plan.source === "reviewer_bypass") {
    return true;
  }
  if (plan.graceUntil) {
    const graceMs = Date.parse(plan.graceUntil);
    if (!Number.isNaN(graceMs) && graceMs > Date.now()) {
      return true;
    }
  }
  if (plan.status === "active") return true;
  if (plan.status === "trial" && Boolean(plan.subscriptionId)) return true;
  return false;
}

/**
 * Whether the layout loader should redirect to `/app/plans`.
 *
 * Fail-open rules:
 * - Never verified (`lastVerifiedAt` missing/null) → do not block.
 * - Callers must catch thrown verification errors and skip the gate entirely.
 */
export function shouldEnforceBillingGate(plan: BillingPlan): boolean {
  if (!plan.lastVerifiedAt) return false;
  return !hasActiveSubscription(plan);
}

/** Comma-separated shop domains that bypass the billing gate (App Store review / emergency). */
export function isBillingGateBypassShop(shopDomain: string): boolean {
  const raw = process.env.BILLING_GATE_BYPASS_SHOPS?.trim() ?? "";
  if (!raw) return false;
  const normalized = shopDomain.trim().toLowerCase();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export function computeFrozenGraceUntil(
  from: Date = new Date(),
  hours: number = BILLING_FROZEN_GRACE_HOURS,
): string {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}
