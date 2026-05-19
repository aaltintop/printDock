import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.server";
import { shopDoc } from "./shop-data.server";

export type OrderIngestQueueStatus = "pending" | "processing" | "failed";

export type OrderIngestQueueItem = {
  id: string;
  shopDomain: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyLineItemId: string;
  sessionToken: string;
  jobId: string;
  lineItemProps: Array<{ name: string; value: string }>;
  signedPriceMapBySession?: Record<string, string>;
  lineTitle?: string;
  lineVariantTitle?: string;
  perFileQuantity?: number;
  status: OrderIngestQueueStatus;
  attempts: number;
  claimedAt?: string;
  leaseExpiresAt?: string;
  enqueuedAt: string;
  lastError?: string;
};

const MAX_ATTEMPTS = 8;
const LEASE_MS = 30 * 60 * 1000;

export function orderIngestQueueCollection(shopDomain: string) {
  return shopDoc(shopDomain).collection("orderIngestQueue");
}

export function buildOrderIngestId(shopifyOrderId: string, shopifyLineItemId: string): string {
  return `${shopifyOrderId}_${shopifyLineItemId}`;
}

export async function enqueueOrderIngest(
  item: Omit<OrderIngestQueueItem, "status" | "attempts" | "enqueuedAt"> & {
    status?: OrderIngestQueueStatus;
    attempts?: number;
  },
): Promise<void> {
  const ref = orderIngestQueueCollection(item.shopDomain).doc(item.id);
  await ref.set(
    {
      ...item,
      status: item.status ?? "pending",
      attempts: item.attempts ?? 0,
      enqueuedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

export async function claimOrderIngestItem(
  shopDomain: string,
  ingestId: string,
): Promise<OrderIngestQueueItem | null> {
  const ref = orderIngestQueueCollection(shopDomain).doc(ingestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const raw = snap.data() as Record<string, unknown>;
    const status = String(raw.status || "");
    const attempts = Number(raw.attempts ?? 0);
    const leaseExpiresAt = raw.leaseExpiresAt ? String(raw.leaseExpiresAt) : "";
    const now = Date.now();
    const leaseExpired = leaseExpiresAt ? Date.parse(leaseExpiresAt) < now : false;

    if (status === "failed") return null;

    const claimable =
      status === "pending" || (status === "processing" && leaseExpired);
    if (!claimable) return null;

    if (attempts >= MAX_ATTEMPTS) {
      tx.set(
        ref,
        { status: "failed", lastError: "max_attempts_exceeded" },
        { merge: true },
      );
      return null;
    }

    const nextAttempts = attempts + 1;
    const claimedAt = new Date().toISOString();
    const nextLease = new Date(now + LEASE_MS).toISOString();
    tx.set(
      ref,
      {
        status: "processing",
        attempts: nextAttempts,
        claimedAt,
        leaseExpiresAt: nextLease,
      },
      { merge: true },
    );

    return normalizeQueueItem(ingestId, shopDomain, {
      ...raw,
      status: "processing",
      attempts: nextAttempts,
      claimedAt,
      leaseExpiresAt: nextLease,
    });
  });
}

export async function completeOrderIngestItem(shopDomain: string, ingestId: string): Promise<void> {
  await orderIngestQueueCollection(shopDomain).doc(ingestId).delete();
}

export async function failOrderIngestItem(
  shopDomain: string,
  ingestId: string,
  lastError: string,
): Promise<void> {
  await orderIngestQueueCollection(shopDomain).doc(ingestId).set(
    { status: "failed", lastError },
    { merge: true },
  );
}

export async function listClaimableOrderIngestIds(
  shopDomain: string,
  limit = 20,
): Promise<string[]> {
  const nowIso = new Date().toISOString();
  const col = orderIngestQueueCollection(shopDomain);

  const [pendingSnap, staleSnap] = await Promise.all([
    col.where("status", "==", "pending").limit(limit).get(),
    col.where("status", "==", "processing").where("leaseExpiresAt", "<", nowIso).limit(limit).get(),
  ]);

  const ids = new Set<string>();
  pendingSnap.docs.forEach((d) => ids.add(d.id));
  staleSnap.docs.forEach((d) => ids.add(d.id));
  return [...ids].slice(0, limit);
}

function normalizeQueueItem(
  id: string,
  shopDomain: string,
  raw: Record<string, unknown>,
): OrderIngestQueueItem {
  const props = Array.isArray(raw.lineItemProps) ? raw.lineItemProps : [];
  return {
    id,
    shopDomain,
    shopifyOrderId: String(raw.shopifyOrderId ?? ""),
    shopifyOrderName: String(raw.shopifyOrderName ?? ""),
    shopifyLineItemId: String(raw.shopifyLineItemId ?? ""),
    sessionToken: String(raw.sessionToken ?? ""),
    jobId: String(raw.jobId ?? ""),
    lineItemProps: props.map((p) => {
      const row = p as { name?: string; value?: string };
      return { name: String(row.name ?? ""), value: String(row.value ?? "") };
    }),
    signedPriceMapBySession: isRecord(raw.signedPriceMapBySession)
      ? (raw.signedPriceMapBySession as Record<string, string>)
      : undefined,
    lineTitle: raw.lineTitle ? String(raw.lineTitle) : undefined,
    lineVariantTitle: raw.lineVariantTitle ? String(raw.lineVariantTitle) : undefined,
    perFileQuantity: raw.perFileQuantity != null ? Number(raw.perFileQuantity) : undefined,
    status: (String(raw.status ?? "pending") as OrderIngestQueueStatus),
    attempts: Number(raw.attempts ?? 0),
    claimedAt: raw.claimedAt ? String(raw.claimedAt) : undefined,
    leaseExpiresAt: raw.leaseExpiresAt ? String(raw.leaseExpiresAt) : undefined,
    enqueuedAt: String(raw.enqueuedAt ?? new Date().toISOString()),
    lastError: raw.lastError ? String(raw.lastError) : undefined,
  };
}

export { MAX_ATTEMPTS as ORDER_INGEST_MAX_ATTEMPTS };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
