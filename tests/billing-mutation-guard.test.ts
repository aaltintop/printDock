import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("billing mutation sources", () => {
  it("have no hardcoded test/isTest literals when Billing API mutations exist", () => {
    const files = billingMutationSourceFiles();
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toMatch(HARDCODED_TEST_FLAG);
    }
  });
});
