import { describe, expect, it } from "vitest";

import {
  computeMonthlyTotals,
  computeOpsTotals,
  formatBytes,
  isOpsSortKey,
  sortOpsRows,
  storageCapBytesForPlan,
  storagePercentOfCap,
} from "../app/services/ops-report.utils";
import type { OpsShopRow } from "../app/services/ops-report.utils";
import { emptyUsageMonthRow } from "../app/services/ops-usage.utils";
import type { UsageMonthRow } from "../app/services/ops-usage.utils";

function row(partial: Partial<OpsShopRow> & { shopDomain: string }): OpsShopRow {
  return {
    planCode: "free",
    planStatus: "inactive",
    planSource: "shopify",
    subscriptionId: null,
    installedAt: null,
    planStartedAt: null,
    lastVerifiedAt: null,
    graceUntil: null,
    storageUsedBytes: 0,
    storageCapBytes: storageCapBytesForPlan("free"),
    storageReconciledAt: null,
    peakStorageBytes: 0,
    avgMonthlyStorageBytes: 0,
    downloadsTotal: 0,
    downloadsThisMonth: 0,
    avgMonthlyDownloads: 0,
    lastDownloadAt: null,
    uploadSessionCount: null,
    orderJobCount: null,
    ...partial,
  };
}

function month(partial: Partial<UsageMonthRow> & { month: string }): UsageMonthRow {
  return { ...emptyUsageMonthRow(partial.month), ...partial };
}

describe("storageCapBytesForPlan", () => {
  it("uses the plan cap and falls back to free for unknown codes", () => {
    expect(storageCapBytesForPlan("pro")).toBe(32_212_254_720);
    expect(storageCapBytesForPlan("free")).toBe(524_288_000);
    expect(storageCapBytesForPlan("nope" as never)).toBe(524_288_000);
  });
});

describe("computeOpsTotals", () => {
  const rows = [
    row({
      shopDomain: "a.myshopify.com",
      planCode: "pro",
      planStatus: "active",
      storageUsedBytes: 3_000,
      storageCapBytes: 10_000,
      downloadsTotal: 100,
      downloadsThisMonth: 10,
      avgMonthlyDownloads: 20,
    }),
    row({
      shopDomain: "b.myshopify.com",
      planCode: "free",
      planStatus: "trial",
      storageUsedBytes: 1_000,
      storageCapBytes: 10_000,
      downloadsTotal: 50,
      downloadsThisMonth: 4,
      avgMonthlyDownloads: 10,
    }),
  ];

  it("sums storage and downloads and derives per-client averages", () => {
    const totals = computeOpsTotals(rows);
    expect(totals.shopCount).toBe(2);
    expect(totals.activeCount).toBe(1);
    expect(totals.trialCount).toBe(1);
    expect(totals.inactiveCount).toBe(0);
    expect(totals.planCounts).toEqual({ free: 1, starter: 0, pro: 1, business: 0 });
    expect(totals.storageUsedBytes).toBe(4_000);
    expect(totals.storageCapBytes).toBe(20_000);
    expect(totals.avgStorageUsedBytes).toBe(2_000);
    expect(totals.downloadsTotal).toBe(150);
    expect(totals.downloadsThisMonth).toBe(14);
    expect(totals.avgDownloadsPerShop).toBe(75);
    expect(totals.avgDownloadsThisMonthPerShop).toBe(7);
    expect(totals.avgMonthlyDownloadsPerShop).toBe(15);
  });

  it("reports null upload/order counts when they were not loaded", () => {
    const totals = computeOpsTotals(rows);
    expect(totals.uploadSessionCount).toBeNull();
    expect(totals.orderJobCount).toBeNull();
  });

  it("sums upload/order counts when present", () => {
    const totals = computeOpsTotals([
      row({ shopDomain: "a.myshopify.com", uploadSessionCount: 5, orderJobCount: 2 }),
      row({ shopDomain: "b.myshopify.com", uploadSessionCount: 7, orderJobCount: 3 }),
    ]);
    expect(totals.uploadSessionCount).toBe(12);
    expect(totals.orderJobCount).toBe(5);
  });

  it("stays at zero for an empty install base", () => {
    const totals = computeOpsTotals([]);
    expect(totals.shopCount).toBe(0);
    expect(totals.avgDownloadsPerShop).toBe(0);
    expect(totals.avgStorageUsedBytes).toBe(0);
  });
});

describe("computeMonthlyTotals", () => {
  it("rolls per-shop months up in the requested order", () => {
    const totals = computeMonthlyTotals(
      ["2026-08", "2026-07"],
      [
        {
          monthly: [
            month({ month: "2026-08", downloads: 4, storageBytesMax: 100, storageSamples: 1 }),
            month({ month: "2026-07", downloads: 9, storageBytesMax: 200, storageSamples: 1 }),
          ],
        },
        {
          monthly: [
            month({ month: "2026-08", downloads: 1, storageBytesMax: 50, storageSamples: 1 }),
            month({ month: "2026-07" }),
          ],
        },
      ],
    );

    expect(totals).toEqual([
      { month: "2026-08", downloads: 5, storageBytesMax: 150, activeShopCount: 2 },
      { month: "2026-07", downloads: 9, storageBytesMax: 200, activeShopCount: 1 },
    ]);
  });
});

describe("formatBytes", () => {
  it("scales units and keeps the output short", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-10)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1_572_864)).toBe("1.50 MB");
    expect(formatBytes(524_288_000)).toBe("500 MB");
    expect(formatBytes(32_212_254_720)).toBe("30.0 GB");
  });
});

describe("storagePercentOfCap", () => {
  it("computes usage percent and tolerates a missing cap", () => {
    expect(storagePercentOfCap(500, 1_000)).toBe(50);
    expect(storagePercentOfCap(0, 1_000)).toBe(0);
    expect(storagePercentOfCap(500, 0)).toBe(0);
  });

  it("clamps runaway overage instead of returning a huge number", () => {
    expect(storagePercentOfCap(1_000_000, 1)).toBe(999);
  });
});

describe("sortOpsRows", () => {
  const rows = [
    row({
      shopDomain: "b.myshopify.com",
      planCode: "free",
      storageUsedBytes: 10,
      downloadsTotal: 90,
      installedAt: "2026-01-01T00:00:00.000Z",
    }),
    row({
      shopDomain: "a.myshopify.com",
      planCode: "business",
      storageUsedBytes: 500,
      downloadsTotal: 5,
      installedAt: "2026-06-01T00:00:00.000Z",
    }),
  ];

  it("sorts by storage descending by default", () => {
    expect(sortOpsRows(rows, "storage").map((r) => r.shopDomain)).toEqual([
      "a.myshopify.com",
      "b.myshopify.com",
    ]);
  });

  it("sorts by downloads, install recency, plan tier, and shop name", () => {
    expect(sortOpsRows(rows, "downloads")[0].shopDomain).toBe("b.myshopify.com");
    expect(sortOpsRows(rows, "installed")[0].shopDomain).toBe("a.myshopify.com");
    expect(sortOpsRows(rows, "plan")[0].shopDomain).toBe("a.myshopify.com");
    expect(sortOpsRows(rows, "shop")[0].shopDomain).toBe("a.myshopify.com");
  });

  it("does not mutate the input", () => {
    const original = rows.map((r) => r.shopDomain);
    sortOpsRows(rows, "downloads");
    expect(rows.map((r) => r.shopDomain)).toEqual(original);
  });
});

describe("isOpsSortKey", () => {
  it("guards query-string input", () => {
    expect(isOpsSortKey("storage")).toBe(true);
    expect(isOpsSortKey("downloadsThisMonth")).toBe(true);
    expect(isOpsSortKey("__proto__")).toBe(false);
    expect(isOpsSortKey("")).toBe(false);
  });
});
