import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveBillingTestMode } from "../app/services/billing-test-mode.server";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const BILLING_MUTATION_MARKERS = [
  "appSubscriptionCreate",
  "appUsageRecordCreate",
  "appSubscriptionLineItemUpdate",
  "billing.request",
  "billing.require",
  "usageRecordCreate",
  "recurringApplicationCharge",
] as const;

const HARDCODED_TEST_FLAG = /\b(test|isTest)\s*:\s*(true|false)\b/;

/** Source files that invoke Shopify charge mutations (extend when adding billing). */
function billingMutationSourceFiles(): string[] {
  const appDir = join(repoRoot, "app");
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const content = readFileSync(full, "utf8");
      if (BILLING_MUTATION_MARKERS.some((marker) => content.includes(marker))) {
        hits.push(full);
      }
    }
  }

  walk(appDir);
  return hits;
}

describe("resolveBillingTestMode", () => {
  it("returns true outside production without calling Admin API", async () => {
    const fetchPartnerDevelopment = vi.fn(async () => false);
    await expect(
      resolveBillingTestMode("levyapps.myshopify.com", {
        nodeEnv: "development",
        fetchPartnerDevelopment,
      }),
    ).resolves.toBe(true);
    expect(fetchPartnerDevelopment).not.toHaveBeenCalled();
  });

  it("returns true in production for partner development stores", async () => {
    await expect(
      resolveBillingTestMode("levyapps.myshopify.com", {
        nodeEnv: "production",
        fetchPartnerDevelopment: async () => true,
      }),
    ).resolves.toBe(true);
  });

  it("returns false only in production for non-development stores", async () => {
    await expect(
      resolveBillingTestMode("live-merchant.myshopify.com", {
        nodeEnv: "production",
        fetchPartnerDevelopment: async () => false,
      }),
    ).resolves.toBe(false);
  });

  it("returns true in production when shop plan lookup is unknown", async () => {
    await expect(
      resolveBillingTestMode("unknown.myshopify.com", {
        nodeEnv: "production",
        fetchPartnerDevelopment: async () => null,
      }),
    ).resolves.toBe(true);
  });

  it("returns true in production when shop plan lookup throws", async () => {
    await expect(
      resolveBillingTestMode("error.myshopify.com", {
        nodeEnv: "production",
        fetchPartnerDevelopment: async () => {
          throw new Error("Admin API unavailable");
        },
      }),
    ).resolves.toBe(true);
  });
});

describe("billing mutation sources", () => {
  it("have no hardcoded test/isTest literals (must use resolveBillingTestMode)", () => {
    const files = billingMutationSourceFiles();
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toMatch(HARDCODED_TEST_FLAG);
    }
  });
});
