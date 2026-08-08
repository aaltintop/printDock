/**
 * Shapes and pure helpers for the per-shop usage counters that back the ops
 * dashboard. Kept free of firebase-admin imports so tests can exercise the
 * month bucketing and sample merging without a Firestore credential.
 */

/** Subcollection under `shops/{shop}` holding one document per UTC month. */
export const USAGE_MONTHLY_COLLECTION = "usageMonthly";

/** Field on `shops/{shop}` holding the lifetime download count. */
export const DOWNLOADS_TOTAL_FIELD = "downloadsTotal";

/** Field on `shops/{shop}` holding the ISO timestamp of the most recent download. */
export const LAST_DOWNLOAD_AT_FIELD = "lastDownloadAt";

/** Which download surface served the file. */
export type DownloadKind = "short_link" | "proxy_token" | "admin_order";

export const DOWNLOAD_KINDS: readonly DownloadKind[] = [
  "short_link",
  "proxy_token",
  "admin_order",
];

const DOWNLOAD_KIND_FIELDS: Record<DownloadKind, string> = {
  short_link: "downloadsShortLink",
  proxy_token: "downloadsProxyToken",
  admin_order: "downloadsAdminOrder",
};

const DOWNLOAD_KIND_LABELS: Record<DownloadKind, string> = {
  short_link: "Storefront short link",
  proxy_token: "Storefront token link",
  admin_order: "Admin order page",
};

export function downloadKindField(kind: DownloadKind): string {
  return DOWNLOAD_KIND_FIELDS[kind];
}

export function downloadKindLabel(kind: DownloadKind): string {
  return DOWNLOAD_KIND_LABELS[kind];
}

export interface UsageMonthRow {
  /** UTC month key, `YYYY-MM`. */
  month: string;
  downloads: number;
  downloadsByKind: Record<DownloadKind, number>;
  /** Storage usage at the most recent snapshot in this month. */
  storageBytesLast: number;
  /** Highest storage usage observed in this month. */
  storageBytesMax: number;
  /** Storage usage at the first snapshot in this month. */
  storageBytesFirst: number;
  storageSamples: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  lastDownloadAt: string | null;
}

/** Coerce a Firestore counter to a non-negative integer. */
export function readCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

function readIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** UTC month bucket, e.g. `2026-08`. UTC so cron and request writers agree. */
export function usageMonthKey(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

const MONTH_KEY_SHAPE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(key: string): boolean {
  return MONTH_KEY_SHAPE.test(key);
}

/** Newest first: `recentMonthKeys(3)` in Aug 2026 → `["2026-08","2026-07","2026-06"]`. */
export function recentMonthKeys(count: number, from: Date = new Date()): string[] {
  const total = Math.max(1, Math.min(60, Math.trunc(count) || 1));
  const keys: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const cursor = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - index, 1),
    );
    keys.push(usageMonthKey(cursor));
  }
  return keys;
}

export function emptyUsageMonthRow(month: string): UsageMonthRow {
  return {
    month,
    downloads: 0,
    downloadsByKind: { short_link: 0, proxy_token: 0, admin_order: 0 },
    storageBytesLast: 0,
    storageBytesMax: 0,
    storageBytesFirst: 0,
    storageSamples: 0,
    firstSampleAt: null,
    lastSampleAt: null,
    lastDownloadAt: null,
  };
}

export function normalizeUsageMonthRow(
  month: string,
  raw: Record<string, unknown> | undefined,
): UsageMonthRow {
  if (!raw) return emptyUsageMonthRow(month);
  return {
    month,
    downloads: readCount(raw.downloads),
    downloadsByKind: {
      short_link: readCount(raw[DOWNLOAD_KIND_FIELDS.short_link]),
      proxy_token: readCount(raw[DOWNLOAD_KIND_FIELDS.proxy_token]),
      admin_order: readCount(raw[DOWNLOAD_KIND_FIELDS.admin_order]),
    },
    storageBytesLast: readCount(raw.storageBytesLast),
    storageBytesMax: readCount(raw.storageBytesMax),
    storageBytesFirst: readCount(raw.storageBytesFirst),
    storageSamples: readCount(raw.storageSamples),
    firstSampleAt: readIso(raw.firstSampleAt),
    lastSampleAt: readIso(raw.lastSampleAt),
    lastDownloadAt: readIso(raw.lastDownloadAt),
  };
}

export interface StorageSampleFields {
  storageBytesLast: number;
  storageBytesMax: number;
  storageBytesFirst: number;
  storageSamples: number;
  firstSampleAt: string;
  lastSampleAt: string;
  updatedAt: string;
}

/**
 * Fold one storage reading into a month document. `storageBytesMax` is why
 * snapshots need a read-modify-write instead of a plain `FieldValue.increment`.
 */
export function mergeStorageSample(
  existing: Record<string, unknown> | StorageSampleFields | undefined,
  bytes: number,
  atIso: string,
): StorageSampleFields {
  const sample = readCount(bytes);
  const priorSamples = readCount(existing?.storageSamples);
  const isFirstSample = priorSamples === 0;
  return {
    storageBytesLast: sample,
    storageBytesMax: Math.max(readCount(existing?.storageBytesMax), sample),
    storageBytesFirst: isFirstSample ? sample : readCount(existing?.storageBytesFirst),
    storageSamples: priorSamples + 1,
    firstSampleAt: isFirstSample ? atIso : (readIso(existing?.firstSampleAt) ?? atIso),
    lastSampleAt: atIso,
    updatedAt: atIso,
  };
}

/**
 * Months that have finished, so averages are not dragged down by a partial
 * current month. Falls back to every row when the shop is too new to have one.
 */
export function completedMonths(rows: UsageMonthRow[], currentMonth: string): UsageMonthRow[] {
  const completed = rows.filter((row) => row.month !== currentMonth);
  return completed.length > 0 ? completed : rows;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

export function averageMonthlyDownloads(rows: UsageMonthRow[]): number {
  return Math.round(mean(rows.map((row) => row.downloads)) * 100) / 100;
}

/** Average of each month's peak storage, so short-lived spikes still register. */
export function averageMonthlyStorageBytes(rows: UsageMonthRow[]): number {
  const sampled = rows.filter((row) => row.storageSamples > 0);
  return Math.round(mean(sampled.map((row) => row.storageBytesMax)));
}

export function peakStorageBytes(rows: UsageMonthRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.storageBytesMax), 0);
}
