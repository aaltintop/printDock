import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import { migratePlanCode } from "../config/plans";
import type { BillingPlanHistoryEntry } from "../types/printdock";
import {
  getBillingPlan,
  jobsCollection,
  listBillingPlanHistory,
  sessionsCollection,
  shopDoc,
} from "./shop-data.server";
import { listShopUsageMonths } from "./ops-usage.server";
import type { UsageMonthRow } from "./ops-usage.utils";
import {
  averageMonthlyDownloads,
  averageMonthlyStorageBytes,
  completedMonths,
  peakStorageBytes,
  readCount,
  usageMonthKey,
} from "./ops-usage.utils";
import type { OpsMonthlyTotalRow, OpsShopRow, OpsTotals } from "./ops-report.utils";
import { computeMonthlyTotals, computeOpsTotals, storageCapBytesForPlan } from "./ops-report.utils";

/**
 * Cross-shop reporting for the operator dashboard. Everything here reads a
 * hand-picked set of fields — the shop document also holds the Shopify access
 * token, which must never reach a report.
 */

export const OPS_DEFAULT_MONTHS = 6;
const OPS_MAX_MONTHS = 24;

/** Shops processed in parallel; keeps Firestore reads bounded on large installs. */
const SHOP_CONCURRENCY = 8;

export interface OpsReport {
  generatedAt: string;
  currentMonth: string;
  /** Newest first. */
  months: string[];
  includeCounts: boolean;
  shops: OpsShopRow[];
  monthlyTotals: OpsMonthlyTotalRow[];
  totals: OpsTotals;
}

export interface OpsShopDetail {
  generatedAt: string;
  currentMonth: string;
  exists: boolean;
  row: OpsShopRow;
  monthly: UsageMonthRow[];
  planHistory: BillingPlanHistoryEntry[];
}

export function clampMonths(value: number | undefined): number {
  if (!Number.isFinite(value)) return OPS_DEFAULT_MONTHS;
  return Math.max(1, Math.min(OPS_MAX_MONTHS, Math.trunc(value as number)));
}

function readIso(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (value && typeof value === "object" && "toDate" in value) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const slice = items.slice(start, start + limit);
    results.push(...(await Promise.all(slice.map(mapper))));
  }
  return results;
}

async function countCollection(
  query: ReturnType<typeof sessionsCollection>,
): Promise<number | null> {
  try {
    const snap = await query.count().get();
    return readCount(snap.data().count);
  } catch (err) {
    log.error("ops_report_count_failed", err);
    return null;
  }
}

type ShopFields = {
  installedAt: string | null;
  storageUsedBytes: number;
  storageReconciledAt: string | null;
  downloadsTotal: number;
  lastDownloadAt: string | null;
};

function readShopFields(raw: Record<string, unknown> | undefined): ShopFields {
  return {
    installedAt: readIso(raw?.installedAt),
    storageUsedBytes: readCount(raw?.storageUsedBytes),
    storageReconciledAt: readIso(raw?.storageUsedBytesReconciledAt),
    downloadsTotal: readCount(raw?.downloadsTotal),
    lastDownloadAt: readIso(raw?.lastDownloadAt),
  };
}

async function buildShopRow(
  shopDomain: string,
  shopFields: ShopFields,
  options: { months: number; currentMonth: string; includeCounts: boolean; now: Date },
): Promise<{ row: OpsShopRow; monthly: UsageMonthRow[] }> {
  const [plan, monthly] = await Promise.all([
    getBillingPlan(shopDomain),
    listShopUsageMonths(shopDomain, options.months, { now: options.now }),
  ]);

  const [uploadSessionCount, orderJobCount] = options.includeCounts
    ? await Promise.all([
        countCollection(sessionsCollection(shopDomain)),
        countCollection(jobsCollection(shopDomain)),
      ])
    : [null, null];

  const planCode = migratePlanCode(String(plan.planCode));
  const settled = completedMonths(monthly, options.currentMonth);
  const thisMonth = monthly.find((row) => row.month === options.currentMonth);

  return {
    monthly,
    row: {
      shopDomain,
      planCode,
      planStatus: plan.status,
      planSource: plan.source ?? null,
      subscriptionId: plan.subscriptionId ?? null,
      installedAt: shopFields.installedAt,
      planStartedAt: plan.planStartedAt ?? null,
      lastVerifiedAt: plan.lastVerifiedAt ?? null,
      graceUntil: plan.graceUntil ?? null,
      storageUsedBytes: shopFields.storageUsedBytes,
      storageCapBytes: storageCapBytesForPlan(planCode),
      storageReconciledAt: shopFields.storageReconciledAt,
      peakStorageBytes: Math.max(peakStorageBytes(monthly), shopFields.storageUsedBytes),
      avgMonthlyStorageBytes: averageMonthlyStorageBytes(settled),
      downloadsTotal: shopFields.downloadsTotal,
      downloadsThisMonth: thisMonth?.downloads ?? 0,
      avgMonthlyDownloads: averageMonthlyDownloads(settled),
      lastDownloadAt: shopFields.lastDownloadAt,
      uploadSessionCount,
      orderJobCount,
    },
  };
}

export async function buildOpsReport(options?: {
  months?: number;
  includeCounts?: boolean;
  now?: Date;
}): Promise<OpsReport> {
  const now = options?.now ?? new Date();
  const months = clampMonths(options?.months);
  const includeCounts = options?.includeCounts === true;
  const currentMonth = usageMonthKey(now);

  const shopsSnap = await db.collection("shops").get();
  const built = await mapWithConcurrency(shopsSnap.docs, SHOP_CONCURRENCY, async (doc) =>
    buildShopRow(doc.id, readShopFields(doc.data() as Record<string, unknown>), {
      months,
      currentMonth,
      includeCounts,
      now,
    }),
  );

  const shops = built.map((entry) => entry.row);
  const monthKeys = built[0]?.monthly.map((row) => row.month) ?? [currentMonth];

  return {
    generatedAt: now.toISOString(),
    currentMonth,
    months: monthKeys,
    includeCounts,
    shops,
    monthlyTotals: computeMonthlyTotals(monthKeys, built),
    totals: computeOpsTotals(shops),
  };
}

export async function buildShopOpsDetail(
  shopDomain: string,
  options?: { months?: number; now?: Date },
): Promise<OpsShopDetail> {
  const now = options?.now ?? new Date();
  const months = clampMonths(options?.months);
  const currentMonth = usageMonthKey(now);

  const snap = await shopDoc(shopDomain).get();
  const [{ row, monthly }, planHistory] = await Promise.all([
    buildShopRow(shopDomain, readShopFields(snap.data() as Record<string, unknown>), {
      months,
      currentMonth,
      includeCounts: true,
      now,
    }),
    listBillingPlanHistory(shopDomain, 20),
  ]);

  return {
    generatedAt: now.toISOString(),
    currentMonth,
    exists: snap.exists,
    row,
    monthly,
    planHistory,
  };
}
