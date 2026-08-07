import { describe, expect, it } from "vitest";

import {
  averageMonthlyDownloads,
  averageMonthlyStorageBytes,
  completedMonths,
  downloadKindField,
  emptyUsageMonthRow,
  isValidMonthKey,
  mergeStorageSample,
  normalizeUsageMonthRow,
  peakStorageBytes,
  readCount,
  recentMonthKeys,
  usageMonthKey,
} from "../app/services/ops-usage.utils";
import type { UsageMonthRow } from "../app/services/ops-usage.utils";

function month(partial: Partial<UsageMonthRow> & { month: string }): UsageMonthRow {
  return { ...emptyUsageMonthRow(partial.month), ...partial };
}

describe("usageMonthKey", () => {
  it("buckets by UTC month", () => {
    expect(usageMonthKey(new Date("2026-08-07T23:53:00.000Z"))).toBe("2026-08");
    expect(usageMonthKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });

  it("does not drift across a local-time month boundary", () => {
    // 23:30 UTC on the last day of the month is still that month, even though
    // it is already the next day in UTC+2.
    expect(usageMonthKey(new Date("2026-07-31T23:30:00.000Z"))).toBe("2026-07");
    expect(usageMonthKey(new Date("2026-08-01T00:30:00.000Z"))).toBe("2026-08");
  });
});

describe("recentMonthKeys", () => {
  it("walks back newest first and crosses the year boundary", () => {
    expect(recentMonthKeys(4, new Date("2026-02-15T00:00:00.000Z"))).toEqual([
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
  });

  it("clamps the count to a usable range", () => {
    expect(recentMonthKeys(0, new Date("2026-08-07T00:00:00.000Z"))).toEqual(["2026-08"]);
    expect(recentMonthKeys(500, new Date("2026-08-07T00:00:00.000Z"))).toHaveLength(60);
  });
});

describe("isValidMonthKey", () => {
  it("accepts YYYY-MM only", () => {
    expect(isValidMonthKey("2026-08")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-8")).toBe(false);
    expect(isValidMonthKey("storage")).toBe(false);
  });
});

describe("readCount", () => {
  it("clamps junk to zero", () => {
    expect(readCount(42)).toBe(42);
    expect(readCount("17")).toBe(17);
    expect(readCount(12.6)).toBe(13);
    expect(readCount(-5)).toBe(0);
    expect(readCount(undefined)).toBe(0);
    expect(readCount(Number.NaN)).toBe(0);
  });
});

describe("mergeStorageSample", () => {
  it("seeds first, last, max and sample count on the first reading", () => {
    const merged = mergeStorageSample(undefined, 1024, "2026-08-01T00:00:00.000Z");
    expect(merged).toMatchObject({
      storageBytesFirst: 1024,
      storageBytesLast: 1024,
      storageBytesMax: 1024,
      storageSamples: 1,
      firstSampleAt: "2026-08-01T00:00:00.000Z",
      lastSampleAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("keeps the running maximum when usage drops after retention", () => {
    const first = mergeStorageSample(undefined, 5_000, "2026-08-01T00:00:00.000Z");
    const second = mergeStorageSample(first, 9_000, "2026-08-02T00:00:00.000Z");
    const third = mergeStorageSample(second, 1_000, "2026-08-03T00:00:00.000Z");

    expect(third.storageBytesFirst).toBe(5_000);
    expect(third.storageBytesLast).toBe(1_000);
    expect(third.storageBytesMax).toBe(9_000);
    expect(third.storageSamples).toBe(3);
    expect(third.firstSampleAt).toBe("2026-08-01T00:00:00.000Z");
    expect(third.lastSampleAt).toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("normalizeUsageMonthRow", () => {
  it("reads counters and per-surface breakdown", () => {
    const row = normalizeUsageMonthRow("2026-08", {
      downloads: 12,
      downloadsShortLink: 7,
      downloadsProxyToken: 4,
      downloadsAdminOrder: 1,
      storageBytesMax: 2048,
      storageSamples: 3,
      firstSampleAt: "2026-08-01T00:00:00.000Z",
      lastSampleAt: "",
    });

    expect(row.downloads).toBe(12);
    expect(row.downloadsByKind).toEqual({ short_link: 7, proxy_token: 4, admin_order: 1 });
    expect(row.storageBytesMax).toBe(2048);
    expect(row.firstSampleAt).toBe("2026-08-01T00:00:00.000Z");
    expect(row.lastSampleAt).toBeNull();
  });

  it("falls back to an empty row for a missing document", () => {
    expect(normalizeUsageMonthRow("2026-08", undefined)).toEqual(emptyUsageMonthRow("2026-08"));
  });
});

describe("downloadKindField", () => {
  it("maps each surface to its own counter field", () => {
    expect(downloadKindField("short_link")).toBe("downloadsShortLink");
    expect(downloadKindField("proxy_token")).toBe("downloadsProxyToken");
    expect(downloadKindField("admin_order")).toBe("downloadsAdminOrder");
  });
});

describe("completedMonths", () => {
  const rows = [
    month({ month: "2026-08", downloads: 3 }),
    month({ month: "2026-07", downloads: 30 }),
  ];

  it("drops the partial current month", () => {
    expect(completedMonths(rows, "2026-08").map((row) => row.month)).toEqual(["2026-07"]);
  });

  it("keeps the current month when it is the only data", () => {
    const onlyCurrent = [month({ month: "2026-08", downloads: 3 })];
    expect(completedMonths(onlyCurrent, "2026-08")).toEqual(onlyCurrent);
  });
});

describe("averages", () => {
  const rows = [
    month({ month: "2026-07", downloads: 10, storageBytesMax: 1_000, storageSamples: 2 }),
    month({ month: "2026-06", downloads: 5, storageBytesMax: 3_000, storageSamples: 2 }),
    month({ month: "2026-05", downloads: 0, storageSamples: 0 }),
  ];

  it("averages downloads over every supplied month, zeros included", () => {
    expect(averageMonthlyDownloads(rows)).toBe(5);
    expect(averageMonthlyDownloads([])).toBe(0);
  });

  it("averages storage over sampled months only, so gaps do not deflate it", () => {
    expect(averageMonthlyStorageBytes(rows)).toBe(2_000);
    expect(averageMonthlyStorageBytes([])).toBe(0);
  });

  it("reports the peak across the window", () => {
    expect(peakStorageBytes(rows)).toBe(3_000);
  });
});
