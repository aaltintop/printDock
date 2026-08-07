import { afterEach, describe, expect, it } from "vitest";

import type { BillingPlan } from "../app/types/printdock";
import {
  BILLING_FROZEN_GRACE_HOURS,
  computeFrozenGraceUntil,
  hasActiveSubscription,
  isBillingGateBypassShop,
  isPathExemptFromBillingRedirect,
  shouldEnforceBillingGate,
} from "../app/services/billing-gate.server";

function plan(partial: Partial<BillingPlan>): BillingPlan {
  return {
    planCode: "free",
    status: "inactive",
    subscriptionId: null,
    lastVerifiedAt: null,
    graceUntil: null,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("isPathExemptFromBillingRedirect", () => {
  it("allows plans, release notes, and glossary", () => {
    expect(isPathExemptFromBillingRedirect("/app/plans")).toBe(true);
    expect(isPathExemptFromBillingRedirect("/app/plans/")).toBe(true);
    expect(isPathExemptFromBillingRedirect("/app/release-notes")).toBe(true);
    expect(isPathExemptFromBillingRedirect("/app/glossary")).toBe(true);
  });

  it("blocks dashboard, fields, orders, onboarding", () => {
    expect(isPathExemptFromBillingRedirect("/app")).toBe(false);
    expect(isPathExemptFromBillingRedirect("/app/fields")).toBe(false);
    expect(isPathExemptFromBillingRedirect("/app/orders")).toBe(false);
    expect(isPathExemptFromBillingRedirect("/app/onboarding")).toBe(false);
  });
});

describe("hasActiveSubscription", () => {
  it("allows active Shopify plans including Free", () => {
    expect(
      hasActiveSubscription(
        plan({ planCode: "free", status: "active", source: "shopify", subscriptionId: "gid://1" }),
      ),
    ).toBe(true);
    expect(
      hasActiveSubscription(
        plan({ planCode: "pro", status: "active", source: "shopify", subscriptionId: "gid://2" }),
      ),
    ).toBe(true);
  });

  it("allows pending trial with subscriptionId", () => {
    expect(
      hasActiveSubscription(
        plan({ status: "trial", subscriptionId: "gid://pending", source: "shopify" }),
      ),
    ).toBe(true);
  });

  it("allows dev_override and reviewer_bypass", () => {
    expect(hasActiveSubscription(plan({ source: "dev_override", status: "inactive" }))).toBe(true);
    expect(hasActiveSubscription(plan({ source: "reviewer_bypass", status: "inactive" }))).toBe(
      true,
    );
  });

  it("allows valid graceUntil (FROZEN window)", () => {
    const graceUntil = computeFrozenGraceUntil();
    expect(hasActiveSubscription(plan({ status: "inactive", graceUntil }))).toBe(true);
  });

  it("denies expired grace and plain inactive", () => {
    expect(
      hasActiveSubscription(
        plan({
          status: "inactive",
          graceUntil: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    ).toBe(false);
    expect(hasActiveSubscription(plan({ status: "inactive" }))).toBe(false);
  });
});

describe("shouldEnforceBillingGate", () => {
  it("fails open when never verified", () => {
    expect(shouldEnforceBillingGate(plan({ status: "inactive", lastVerifiedAt: null }))).toBe(
      false,
    );
  });

  it("enforces when verified inactive", () => {
    expect(
      shouldEnforceBillingGate(
        plan({ status: "inactive", lastVerifiedAt: new Date().toISOString() }),
      ),
    ).toBe(true);
  });

  it("does not enforce when active after verify", () => {
    expect(
      shouldEnforceBillingGate(
        plan({
          status: "active",
          lastVerifiedAt: new Date().toISOString(),
          source: "shopify",
          subscriptionId: "gid://x",
        }),
      ),
    ).toBe(false);
  });

  it("does not enforce during grace", () => {
    expect(
      shouldEnforceBillingGate(
        plan({
          status: "inactive",
          lastVerifiedAt: new Date().toISOString(),
          graceUntil: computeFrozenGraceUntil(),
        }),
      ),
    ).toBe(false);
  });
});

describe("isBillingGateBypassShop", () => {
  const prev = process.env.BILLING_GATE_BYPASS_SHOPS;

  afterEach(() => {
    if (prev === undefined) delete process.env.BILLING_GATE_BYPASS_SHOPS;
    else process.env.BILLING_GATE_BYPASS_SHOPS = prev;
  });

  it("matches comma-separated allowlist case-insensitively", () => {
    process.env.BILLING_GATE_BYPASS_SHOPS = "Review-Shop.myshopify.com, other.myshopify.com";
    expect(isBillingGateBypassShop("review-shop.myshopify.com")).toBe(true);
    expect(isBillingGateBypassShop("nope.myshopify.com")).toBe(false);
  });
});

describe("computeFrozenGraceUntil", () => {
  it(`defaults to ${BILLING_FROZEN_GRACE_HOURS} hours`, () => {
    const from = new Date("2026-08-07T12:00:00.000Z");
    const until = computeFrozenGraceUntil(from);
    expect(until).toBe(
      new Date(from.getTime() + BILLING_FROZEN_GRACE_HOURS * 60 * 60 * 1000).toISOString(),
    );
  });
});
