import type { CollectionReference } from "firebase-admin/firestore";
import { db } from "../firebase.server";
import { getPlan } from "../config/plans";
import type { OrderJob, UploadAsset, UploadSession } from "../types/printdock";
import { deleteFile, deleteStorageByPrefix } from "./storage.server";
import {
  fieldsCollection,
  getEffectiveBillingPlan,
  jobAuditCollection,
  jobsCollection,
  listOrderJobs,
  listUploadSessions,
  mergeOrderJob,
  reuploadRequestsCollection,
  sessionsCollection,
  sessionAssetsCollection,
  shopDoc,
  updateUploadSession,
} from "./shop-data.server";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StorageRetentionReport {
  shopDomain: string;
  filesDeleted: number;
  pathsDeleted: string[];
  jobsUpdated: number;
  sessionsUpdated: number;
}

function uploadPrefix(shopDomain: string): string {
  return `uploads/${shopDomain}/`;
}

function isSafeStoragePath(path: string, shopDomain: string): boolean {
  const prefix = uploadPrefix(shopDomain);
  return path.startsWith(prefix) && !path.includes("..");
}

function parseTimeMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Earliest anchor wins per path (oldest reference → delete first when past cutoff).
 */
function collectPathAnchorsMs(
  shopDomain: string,
  jobs: OrderJob[],
  sessions: UploadSession[],
): Map<string, number> {
  const map = new Map<string, number>();

  const add = (rawPath: string | undefined | null, anchorMs: number) => {
    if (!rawPath) return;
    const path = rawPath.trim();
    if (!path) return;
    if (!isSafeStoragePath(path, shopDomain)) return;
    const prev = map.get(path);
    if (prev === undefined || anchorMs < prev) {
      map.set(path, anchorMs);
    }
  };

  for (const job of jobs) {
    const anchorMs = parseTimeMs(job.createdAt);
    if (job.assetSnapshot?.storagePath) {
      add(job.assetSnapshot.storagePath, anchorMs);
    }
    if (job.legacySessionUploadPath) {
      add(job.legacySessionUploadPath, anchorMs);
    }
  }

  for (const session of sessions) {
    const anchorMs = parseTimeMs(session.createdAt);
    for (const asset of session.assets) {
      if (!asset.storagePath?.trim()) continue;
      if (asset.storagePath.includes("/orders/")) {
        if (!map.has(asset.storagePath)) {
          add(asset.storagePath, anchorMs);
        }
      } else {
        add(asset.storagePath, anchorMs);
      }
    }
  }

  return map;
}

function stripExpiredAsset(asset: UploadAsset): UploadAsset {
  return {
    ...asset,
    storagePath: "",
    sizeBytes: 0,
    storageExpired: true,
  };
}

/**
 * Deletes storage files past retention for the shop’s current plan and patches Firestore.
 *
 * @param options.fileStorageDaysOverride Use `0` to delete all known paths immediately (uninstall purge of blobs).
 */
export async function runStorageRetentionForShop(
  shopDomain: string,
  options?: { fileStorageDaysOverride?: number },
): Promise<StorageRetentionReport> {
  const billing = await getEffectiveBillingPlan(shopDomain);
  const plan = getPlan(billing.planCode);
  const days =
    options?.fileStorageDaysOverride !== undefined
      ? options.fileStorageDaysOverride
      : plan.fileStorageDays;

  const now = Date.now();
  const cutoffMs = days <= 0 ? now + 1 : now - Math.max(0, days) * MS_PER_DAY;

  const jobs = await listOrderJobs(shopDomain);
  const sessions = await listUploadSessions(shopDomain);

  const anchors = collectPathAnchorsMs(shopDomain, jobs, sessions);
  const pathsToDelete: string[] = [];
  for (const [path, anchorMs] of anchors) {
    if (anchorMs < cutoffMs) {
      pathsToDelete.push(path);
    }
  }

  const deleted = new Set<string>();
  for (const path of pathsToDelete) {
    await deleteFile(path);
    deleted.add(path);
  }

  let jobsUpdated = 0;
  for (const job of jobs) {
    const assetTouch =
      Boolean(job.assetSnapshot?.storagePath) &&
      deleted.has(String(job.assetSnapshot?.storagePath));
    const legacyTouch =
      Boolean(job.legacySessionUploadPath) &&
      deleted.has(String(job.legacySessionUploadPath));

    if (!assetTouch && !legacyTouch) continue;

    let nextAsset: UploadAsset | null = job.assetSnapshot;
    if (assetTouch && nextAsset) {
      nextAsset = stripExpiredAsset(nextAsset);
    }

    await mergeOrderJob(shopDomain, job.id, {
      assetSnapshot: nextAsset,
      legacySessionUploadPath: legacyTouch ? "" : job.legacySessionUploadPath,
    });
    jobsUpdated++;
  }

  let sessionsUpdated = 0;
  for (const session of sessions) {
    let changed = false;
    const nextAssets = session.assets.map((a) => {
      if (a.storagePath && deleted.has(a.storagePath)) {
        changed = true;
        return stripExpiredAsset(a);
      }
      return a;
    });
    if (!changed) continue;

    const allStripped =
      nextAssets.length > 0 && nextAssets.every((a) => !a.storagePath.trim());
    const nextStatus = allStripped ? "expired" : session.status;

    await updateUploadSession(shopDomain, session.id, {
      assets: nextAssets,
      asset: nextAssets[0] ?? null,
      status: nextStatus,
    });
    sessionsUpdated++;
  }

  return {
    shopDomain,
    filesDeleted: pathsToDelete.length,
    pathsDeleted: pathsToDelete,
    jobsUpdated,
    sessionsUpdated,
  };
}

async function deleteCollectionInBatches(
  col: CollectionReference,
  batchSize = 400,
): Promise<void> {
  let snapshot = await col.limit(batchSize).get();
  while (!snapshot.empty) {
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    snapshot = await col.limit(batchSize).get();
  }
}

async function purgeShopFirestore(shopDomain: string): Promise<void> {
  const shopRef = shopDoc(shopDomain);

  const sessionSnaps = await sessionsCollection(shopDomain).get();
  for (const doc of sessionSnaps.docs) {
    await deleteCollectionInBatches(sessionAssetsCollection(shopDomain, doc.id));
    await doc.ref.delete();
  }

  const jobSnaps = await jobsCollection(shopDomain).get();
  for (const doc of jobSnaps.docs) {
    await deleteCollectionInBatches(jobAuditCollection(shopDomain, doc.id));
    await deleteCollectionInBatches(reuploadRequestsCollection(shopDomain, doc.id));
    await doc.ref.delete();
  }

  await deleteCollectionInBatches(fieldsCollection(shopDomain));

  const billingPlanRef = shopRef.collection("billing").doc("plan");
  const billingPlanSnap = await billingPlanRef.get();
  if (billingPlanSnap.exists) {
    await billingPlanRef.delete();
  }

  await deleteCollectionInBatches(shopRef.collection("productCollectionCache"));

  const shopSnap = await shopRef.get();
  if (shopSnap.exists) {
    await shopRef.delete();
  }

  const legacySessions = await db
    .collection("sessions")
    .where("shopDomain", "==", shopDomain)
    .get();
  for (const doc of legacySessions.docs) {
    await doc.ref.delete();
  }

  const legacyJobs = await db.collection("jobs").where("shopDomain", "==", shopDomain).get();
  for (const doc of legacyJobs.docs) {
    await doc.ref.delete();
  }

  const legacyBilling = await db.collection("billingPlans").doc(shopDomain).get();
  if (legacyBilling.exists) {
    await legacyBilling.ref.delete();
  }

  const legacyFields = await db
    .collection("uploadFields")
    .where("shopDomain", "==", shopDomain)
    .get();
  for (const doc of legacyFields.docs) {
    await doc.ref.delete();
  }
}

/**
 * GDPR / uninstall: remove all GCS objects under the shop prefix and delete Firestore shop data (nested + legacy).
 */
export async function purgeShopStorageAndFirestore(shopDomain: string): Promise<{
  storageObjectsDeleted: number;
}> {
  const storageObjectsDeleted = await deleteStorageByPrefix(uploadPrefix(shopDomain));
  await purgeShopFirestore(shopDomain);
  return { storageObjectsDeleted };
}
