import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import { shopDoc } from "./shop-data.server";
import type { DownloadKind, UsageMonthRow } from "./ops-usage.utils";
import {
  DOWNLOADS_TOTAL_FIELD,
  LAST_DOWNLOAD_AT_FIELD,
  USAGE_MONTHLY_COLLECTION,
  downloadKindField,
  emptyUsageMonthRow,
  isValidMonthKey,
  mergeStorageSample,
  normalizeUsageMonthRow,
  recentMonthKeys,
  usageMonthKey,
} from "./ops-usage.utils";

/**
 * Usage counters for the operator dashboard.
 *
 * Downloads are counted here because signed Storage URLs are served by Google
 * directly — once we hand out the redirect we never see the transfer, so the
 * redirect handoff is the only place we can count.
 *
 * Every write is best-effort: a failed counter must never break a download.
 */

function usageMonthlyCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection(USAGE_MONTHLY_COLLECTION);
}

function usageMonthlyDoc(shopDomain: string, month: string) {
  return usageMonthlyCollection(shopDomain).doc(month);
}

/**
 * Increment the lifetime and current-month download counters for a shop.
 * Swallows errors by design — callers are on the download hot path.
 */
export async function recordDownloadEvent(
  shopDomain: string,
  kind: DownloadKind,
  options?: { at?: Date },
): Promise<void> {
  const shop = shopDomain.trim();
  if (!shop) return;
  const at = options?.at ?? new Date();
  const atIso = at.toISOString();
  const month = usageMonthKey(at);

  try {
    const batch = db.batch();
    batch.set(
      shopDoc(shop),
      {
        [DOWNLOADS_TOTAL_FIELD]: FieldValue.increment(1),
        [LAST_DOWNLOAD_AT_FIELD]: atIso,
      },
      { merge: true },
    );
    batch.set(
      usageMonthlyDoc(shop, month),
      {
        month,
        downloads: FieldValue.increment(1),
        [downloadKindField(kind)]: FieldValue.increment(1),
        lastDownloadAt: atIso,
        updatedAt: atIso,
      },
      { merge: true },
    );
    await batch.commit();
  } catch (err) {
    log.error("download_counter_increment_failed", err, { shopDomain: shop, kind });
  }
}

/**
 * Persist one storage reading into the shop's current month bucket. Runs in a
 * transaction because the running maximum needs the previous value.
 */
export async function snapshotShopStorageUsage(
  shopDomain: string,
  storageUsedBytes: number,
  options?: { at?: Date },
): Promise<void> {
  const shop = shopDomain.trim();
  if (!shop) return;
  const at = options?.at ?? new Date();
  const atIso = at.toISOString();
  const month = usageMonthKey(at);
  const ref = usageMonthlyDoc(shop, month);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const fields = mergeStorageSample(
      snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
      storageUsedBytes,
      atIso,
    );
    tx.set(ref, { month, ...fields }, { merge: true });
  });
}

/**
 * Month rows for a shop, newest first, one entry per requested month even when
 * the shop has no document for it.
 */
export async function listShopUsageMonths(
  shopDomain: string,
  months: number,
  options?: { now?: Date },
): Promise<UsageMonthRow[]> {
  const keys = recentMonthKeys(months, options?.now ?? new Date());
  const oldestKey = keys[keys.length - 1];
  const snap = await usageMonthlyCollection(shopDomain)
    .where("month", ">=", oldestKey)
    .orderBy("month", "desc")
    .get();

  const byMonth = new Map<string, Record<string, unknown>>();
  for (const doc of snap.docs) {
    if (!isValidMonthKey(doc.id)) continue;
    byMonth.set(doc.id, doc.data() as Record<string, unknown>);
  }

  return keys.map((month) => {
    const raw = byMonth.get(month);
    return raw ? normalizeUsageMonthRow(month, raw) : emptyUsageMonthRow(month);
  });
}
