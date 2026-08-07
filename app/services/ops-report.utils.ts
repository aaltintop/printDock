import type { PlanCode } from "../config/plans";
import { PLANS } from "../config/plans";
import type { UsageMonthRow } from "./ops-usage.utils";

/**
 * Row shapes and pure aggregation for the operator dashboard. No firebase-admin
 * import here so the maths is unit-testable.
 */

export interface OpsShopRow {
  shopDomain: string;
  planCode: PlanCode;
  planStatus: "active" | "inactive" | "trial";
  planSource: string | null;
  subscriptionId: string | null;
  /** When the app was installed on the shop. */
  installedAt: string | null;
  /** When the shop started its current plan (null when never subscribed). */
  planStartedAt: string | null;
  lastVerifiedAt: string | null;
  graceUntil: string | null;
  /** Live billable storage counter from `shops/{shop}.storageUsedBytes`. */
  storageUsedBytes: number;
  storageCapBytes: number;
  storageReconciledAt: string | null;
  /** Highest storage seen across the months we loaded. */
  peakStorageBytes: number;
  /** Mean of monthly storage peaks over completed months. */
  avgMonthlyStorageBytes: number;
  downloadsTotal: number;
  downloadsThisMonth: number;
  /** Mean downloads per completed month. */
  avgMonthlyDownloads: number;
  lastDownloadAt: string | null;
  /** `null` when counts were not requested. */
  uploadSessionCount: number | null;
  orderJobCount: number | null;
}

export interface OpsMonthlyTotalRow {
  month: string;
  downloads: number;
  /** Sum of every shop's peak storage for the month. */
  storageBytesMax: number;
  /** Shops that recorded a download or a storage sample in the month. */
  activeShopCount: number;
}

export interface OpsTotals {
  shopCount: number;
  activeCount: number;
  trialCount: number;
  inactiveCount: number;
  planCounts: Record<PlanCode, number>;
  storageUsedBytes: number;
  storageCapBytes: number;
  avgStorageUsedBytes: number;
  downloadsTotal: number;
  downloadsThisMonth: number;
  avgDownloadsPerShop: number;
  avgDownloadsThisMonthPerShop: number;
  avgMonthlyDownloadsPerShop: number;
  uploadSessionCount: number | null;
  orderJobCount: number | null;
}

export function storageCapBytesForPlan(planCode: PlanCode): number {
  return (PLANS[planCode] ?? PLANS.free).maxTotalStorageBytes;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function computeOpsTotals(rows: OpsShopRow[]): OpsTotals {
  const planCounts: Record<PlanCode, number> = { free: 0, starter: 0, pro: 0, business: 0 };
  for (const row of rows) {
    planCounts[row.planCode] = (planCounts[row.planCode] ?? 0) + 1;
  }

  const shopCount = rows.length;
  const storageUsedBytes = sum(rows.map((row) => row.storageUsedBytes));
  const downloadsTotal = sum(rows.map((row) => row.downloadsTotal));
  const downloadsThisMonth = sum(rows.map((row) => row.downloadsThisMonth));
  const countedRows = rows.filter((row) => row.uploadSessionCount !== null);

  return {
    shopCount,
    activeCount: rows.filter((row) => row.planStatus === "active").length,
    trialCount: rows.filter((row) => row.planStatus === "trial").length,
    inactiveCount: rows.filter((row) => row.planStatus === "inactive").length,
    planCounts,
    storageUsedBytes,
    storageCapBytes: sum(rows.map((row) => row.storageCapBytes)),
    avgStorageUsedBytes: shopCount === 0 ? 0 : Math.round(storageUsedBytes / shopCount),
    downloadsTotal,
    downloadsThisMonth,
    avgDownloadsPerShop: shopCount === 0 ? 0 : round2(downloadsTotal / shopCount),
    avgDownloadsThisMonthPerShop:
      shopCount === 0 ? 0 : round2(downloadsThisMonth / shopCount),
    avgMonthlyDownloadsPerShop:
      shopCount === 0 ? 0 : round2(sum(rows.map((row) => row.avgMonthlyDownloads)) / shopCount),
    uploadSessionCount:
      countedRows.length === 0 ? null : sum(countedRows.map((row) => row.uploadSessionCount ?? 0)),
    orderJobCount:
      countedRows.length === 0 ? null : sum(countedRows.map((row) => row.orderJobCount ?? 0)),
  };
}

/**
 * Roll per-shop month rows up into one row per month, newest first per the
 * order of `months`.
 */
export function computeMonthlyTotals(
  months: string[],
  perShopRows: Array<{ monthly: UsageMonthRow[] }>,
): OpsMonthlyTotalRow[] {
  return months.map((month) => {
    const rowsForMonth = perShopRows
      .map((shop) => shop.monthly.find((row) => row.month === month))
      .filter((row): row is UsageMonthRow => Boolean(row));
    return {
      month,
      downloads: sum(rowsForMonth.map((row) => row.downloads)),
      storageBytesMax: sum(rowsForMonth.map((row) => row.storageBytesMax)),
      activeShopCount: rowsForMonth.filter(
        (row) => row.downloads > 0 || row.storageSamples > 0,
      ).length,
    };
  });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe === 0) return "0 B";
  let value = safe;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unitIndex]}`;
}

/** Percent of the plan's storage cap in use, clamped to [0, 999]. */
export function storagePercentOfCap(usedBytes: number, capBytes: number): number {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return 0;
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  return Math.min(999, round2((used / capBytes) * 100));
}

export type OpsSortKey =
  | "storage"
  | "downloads"
  | "downloadsThisMonth"
  | "installed"
  | "shop"
  | "plan";

export const OPS_SORT_KEYS: readonly OpsSortKey[] = [
  "storage",
  "downloads",
  "downloadsThisMonth",
  "installed",
  "shop",
  "plan",
];

export function isOpsSortKey(value: string): value is OpsSortKey {
  return (OPS_SORT_KEYS as readonly string[]).includes(value);
}

const PLAN_RANK: Record<PlanCode, number> = { business: 4, pro: 3, starter: 2, free: 1 };

/** Returns a new array; descending for numeric keys, ascending for shop domain. */
export function sortOpsRows(rows: OpsShopRow[], sortKey: OpsSortKey): OpsShopRow[] {
  const sorted = [...rows];
  switch (sortKey) {
    case "downloads":
      return sorted.sort((a, b) => b.downloadsTotal - a.downloadsTotal);
    case "downloadsThisMonth":
      return sorted.sort((a, b) => b.downloadsThisMonth - a.downloadsThisMonth);
    case "installed":
      return sorted.sort(
        (a, b) => Date.parse(b.installedAt ?? "") - Date.parse(a.installedAt ?? "") || 0,
      );
    case "shop":
      return sorted.sort((a, b) => a.shopDomain.localeCompare(b.shopDomain));
    case "plan":
      return sorted.sort(
        (a, b) =>
          PLAN_RANK[b.planCode] - PLAN_RANK[a.planCode] ||
          a.shopDomain.localeCompare(b.shopDomain),
      );
    case "storage":
    default:
      return sorted.sort((a, b) => b.storageUsedBytes - a.storageUsedBytes);
  }
}
