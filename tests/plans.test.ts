import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PLANS, PLAN_SUBSCRIPTION_NAMES, type PlanCode } from "../app/config/plans";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Frozen table — any drift from app/config/plans.ts must be a deliberate review. */
const EXPECTED: Record<
  PlanCode,
  {
    maxFileSizeBytes: number;
    maxUploadFields: number;
    fileStorageDays: number;
    maxTotalStorageBytes: number;
    advancedValidation: boolean;
    fileRenaming: boolean;
    dynamicPricing: boolean;
    subscriptionName: string;
  }
> = {
  free: {
    maxFileSizeBytes: 52_428_800,
    maxUploadFields: 2,
    fileStorageDays: 7,
    maxTotalStorageBytes: 524_288_000,
    advancedValidation: false,
    fileRenaming: false,
    dynamicPricing: false,
    subscriptionName: "Free",
  },
  starter: {
    maxFileSizeBytes: 104_857_600,
    maxUploadFields: -1,
    fileStorageDays: 30,
    maxTotalStorageBytes: 16_106_127_360,
    advancedValidation: false,
    fileRenaming: false,
    dynamicPricing: false,
    subscriptionName: "Starter",
  },
  pro: {
    maxFileSizeBytes: 314_572_800,
    maxUploadFields: -1,
    fileStorageDays: 30,
    maxTotalStorageBytes: 32_212_254_720,
    advancedValidation: true,
    fileRenaming: true,
    dynamicPricing: true,
    subscriptionName: "Pro",
  },
  business: {
    maxFileSizeBytes: 5_368_709_120,
    maxUploadFields: -1,
    fileStorageDays: 30,
    maxTotalStorageBytes: 80_530_636_800,
    advancedValidation: true,
    fileRenaming: true,
    dynamicPricing: true,
    subscriptionName: "Business",
  },
};

describe("PLANS frozen table", () => {
  for (const code of Object.keys(EXPECTED) as PlanCode[]) {
    it(`matches expected limits for ${code}`, () => {
      const plan = PLANS[code];
      const expected = EXPECTED[code];
      expect(plan.maxFileSizeBytes).toBe(expected.maxFileSizeBytes);
      expect(plan.maxUploadFields).toBe(expected.maxUploadFields);
      expect(plan.fileStorageDays).toBe(expected.fileStorageDays);
      expect(plan.maxTotalStorageBytes).toBe(expected.maxTotalStorageBytes);
      expect(plan.advancedValidation).toBe(expected.advancedValidation);
      expect(plan.fileRenaming).toBe(expected.fileRenaming);
      expect(plan.dynamicPricing).toBe(expected.dynamicPricing);
      expect(PLAN_SUBSCRIPTION_NAMES[code]).toBe(expected.subscriptionName);
    });
  }
});

describe("PLAN_CONDITIONS.md mirrors plans.ts", () => {
  const md = readFileSync(join(repoRoot, "docs/PLAN_CONDITIONS.md"), "utf8");

  function section(planHeading: string): string {
    const re = new RegExp(`## ${planHeading}[\\s\\S]*?(?=\\n## |$)`);
    const match = md.match(re);
    expect(match, `missing section ${planHeading}`).toBeTruthy();
    return match![0];
  }

  it("documents Free / Starter / Pro / Business caps", () => {
    const free = section("Free");
    expect(free).toMatch(/Max file size:\s*50 MB/);
    expect(free).toMatch(/Max upload fields:\s*2/);
    expect(free).toMatch(/File retention:\s*7 days/);
    expect(free).toMatch(/Total storage cap:\s*500 MB/);
    expect(free).toMatch(/dynamicPricing:\s*disabled/);

    const starter = section("Starter");
    expect(starter).toMatch(/Max file size:\s*100 MB/);
    expect(starter).toMatch(/File retention:\s*30 days/);
    expect(starter).toMatch(/Total storage cap:\s*15 GB/);
    expect(starter).toMatch(/advancedValidation:\s*disabled/);
    expect(starter).toMatch(/fileRenaming:\s*disabled/);
    expect(starter).toMatch(/dynamicPricing:\s*disabled/);

    const pro = section("Pro");
    expect(pro).toMatch(/Max file size:\s*300 MB/);
    expect(pro).toMatch(/Total storage cap:\s*30 GB/);
    expect(pro).toMatch(/advancedValidation:\s*enabled/);
    expect(pro).toMatch(/dynamicPricing:\s*enabled/);

    const business = section("Business");
    expect(business).toMatch(/Max file size:\s*5 GB/);
    expect(business).toMatch(/Total storage cap:\s*75 GB/);
  });

  it("documents the 500 MB processing ceiling follow-up", () => {
    expect(md).toMatch(/Processing ceiling/);
    expect(md).toMatch(/500 MB/);
  });
});
