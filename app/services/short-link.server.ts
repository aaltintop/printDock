import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.server";

/**
 * Short-link mapping for the `Print Ready File` line item property and
 * customer-facing download URLs.
 *
 * Each upload that confirms successfully gets a short, opaque ID that
 * maps to its storage path. The `/apps/printdock/f/:shortId` app proxy
 * route resolves the ID to a fresh signed storage URL on every click,
 * which means:
 *   - The URL stored in the order property is short and stable forever.
 *   - The actual signed Storage URL is regenerated per click and stays
 *     short-lived for security.
 *
 * Records are keyed under `shops/{shopDomain}/downloadShortLinks/{shortId}`.
 */

const SHORT_ID_LENGTH = 10;
const BASE62_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX_SHORT_ID_GENERATION_ATTEMPTS = 5;

export type ShortLinkRecord = {
  storagePath: string;
  originalName: string;
  legacyStoragePath?: string;
};

function generateRandomShortId(length = SHORT_ID_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length];
  }
  return out;
}

export function shortLinksCollection(shopDomain: string) {
  return db
    .collection("shops")
    .doc(shopDomain)
    .collection("downloadShortLinks");
}

/**
 * Creates a new short link entry for the given file. Returns the short ID
 * that should be embedded in the URL. Retries on the extremely unlikely
 * event of an ID collision.
 */
export async function createShortLink(
  shopDomain: string,
  storagePath: string,
  originalName: string,
): Promise<string> {
  if (!shopDomain || !storagePath) {
    throw new Error("short_link_invalid_input");
  }
  const safeName = (originalName || "").slice(0, 256);

  for (let attempt = 0; attempt < MAX_SHORT_ID_GENERATION_ATTEMPTS; attempt++) {
    const shortId = generateRandomShortId();
    const ref = shortLinksCollection(shopDomain).doc(shortId);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({
      storagePath,
      originalName: safeName,
      createdAt: FieldValue.serverTimestamp(),
    });
    return shortId;
  }
  throw new Error("short_link_id_collision");
}

/** Returns a 10-char base62 short ID or null when the input is invalid. */
export function isValidShortIdShape(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 4 || value.length > 32) return false;
  return /^[A-Za-z0-9]+$/.test(value);
}

export async function lookupShortLink(
  shopDomain: string,
  shortId: string,
): Promise<ShortLinkRecord | null> {
  if (!shopDomain || !isValidShortIdShape(shortId)) return null;
  const ref = shortLinksCollection(shopDomain).doc(shortId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const raw = snap.data();
  if (!raw) return null;
  const legacyStoragePath =
    typeof raw.legacyStoragePath === "string" && raw.legacyStoragePath.trim()
      ? raw.legacyStoragePath.trim()
      : undefined;
  return {
    storagePath: String(raw.storagePath || ""),
    originalName: String(raw.originalName || ""),
    legacyStoragePath,
  };
}

/** Lowercase hostname only, no scheme or path. */
export function resolvePrintReadyPublicHost(
  shopDomain: string,
  publicHost: string | null | undefined,
): string {
  const fallback = String(shopDomain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!publicHost) return fallback || String(shopDomain || "").trim();
  const h = String(publicHost)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return h || fallback;
}

/**
 * Ensures the value stored on the line item is a bare https app-proxy URL so
 * Shopify Admin can auto-linkify it. Rejects accidental label prefixes,
 * invisible Unicode, and URLs that are not the PrintDock short path.
 */
export function normalizePrintReadyFileUrl(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw)
    .trim()
    .replace(/[\u200B\uFEFF\u200C\u200D]/g, "");
  if (!/^https:\/\//i.test(s)) {
    const extracted = s.match(/https:\/\/[^\s]+/i);
    if (extracted) {
      s = extracted[0].replace(/[\u200B\uFEFF\u200C\u200D]/g, "").trim();
    }
  }
  s = s.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(s)) return null;
  if (/^http:\/\//i.test(s)) return null;
  if (!/\/apps\/printdock\/f\/[A-Za-z0-9]+$/i.test(s)) return null;
  return s;
}

type BuildShortLinkUrlOptions = {
  /** Primary storefront host (e.g. example.com) when different from myshopify.com */
  publicHost?: string | null;
};

/**
 * Hostname from the browser (`window.location.hostname`) when confirming upload.
 * Lets the Print Ready URL use the merchant’s live storefront host (often the
 * primary domain) instead of `{shop}.myshopify.com`, which can affect how Admin
 * renders/links the value.
 */
export function sanitizePrintReadyPublicHost(
  raw: unknown,
  shopDomain: string,
): string | null {
  if (raw == null || raw === "") return null;
  const h = String(raw).trim().toLowerCase().replace(/:\d+$/, "");
  if (h.length < 3 || h.length > 253) return null;
  if (!/^[a-z0-9.-]+$/i.test(h) || h.includes("..")) return null;
  const shop = shopDomain.trim().toLowerCase();
  if (h.endsWith(".myshopify.com") && h !== shop) return null;
  return h;
}

/**
 * Builds the public, customer/merchant-facing URL for a short link.
 * Uses Shopify's app proxy (shop domain + configured subpath) so the
 * link is on the merchant's storefront origin and is auto-signed by
 * Shopify on each click.
 */
export function buildShortLinkPublicUrl(
  shopDomain: string,
  shortId: string,
  options?: BuildShortLinkUrlOptions,
): string {
  const host = resolvePrintReadyPublicHost(shopDomain, options?.publicHost);
  return `https://${host}/apps/printdock/f/${shortId}`;
}

const SHORT_LINK_PATH_RE = /\/apps\/printdock\/f\/([A-Za-z0-9]+)\/?$/i;

/** Parse short ID from a Print Ready File line property value. */
export function extractShortIdFromPrintReadyUrl(raw: unknown): string | null {
  const normalized = normalizePrintReadyFileUrl(raw);
  if (!normalized) return null;
  const match = normalized.match(SHORT_LINK_PATH_RE);
  return match?.[1] ?? null;
}

export async function updateShortLinkRecord(
  shopDomain: string,
  shortId: string,
  patch: { storagePath?: string; originalName?: string; repointedAt?: string; legacyStoragePath?: string },
): Promise<void> {
  if (!shopDomain || !isValidShortIdShape(shortId)) {
    throw new Error("short_link_invalid_input");
  }
  const ref = shortLinksCollection(shopDomain).doc(shortId);
  const payload: Record<string, unknown> = {};
  if (patch.storagePath != null) payload.storagePath = patch.storagePath;
  if (patch.originalName != null) payload.originalName = patch.originalName.slice(0, 256);
  if (patch.repointedAt != null) payload.repointedAt = patch.repointedAt;
  if (patch.legacyStoragePath != null) payload.legacyStoragePath = patch.legacyStoragePath;
  await ref.set(payload, { merge: true });
}

export async function markShortLinkRepointed(
  shopDomain: string,
  shortId: string,
  orderPath: string,
  originalName: string,
  legacyStoragePath?: string,
): Promise<void> {
  await updateShortLinkRecord(shopDomain, shortId, {
    storagePath: orderPath,
    originalName,
    repointedAt: new Date().toISOString(),
    legacyStoragePath,
  });
}

const FIRESTORE_IN_LIMIT = 30;

/** Batched lookup of short-link docs for specific storage paths (no full collection scan). */
export async function lookupShortLinksForStoragePaths(
  shopDomain: string,
  paths: string[],
): Promise<Map<string, Array<{ shortId: string; record: ShortLinkRecord }>>> {
  const result = new Map<string, Array<{ shortId: string; record: ShortLinkRecord }>>();
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = unique.slice(i, i + FIRESTORE_IN_LIMIT);
    const snap = await shortLinksCollection(shopDomain).where("storagePath", "in", chunk).get();
    for (const doc of snap.docs) {
      const raw = doc.data();
      const storagePath = String(raw.storagePath || "");
      const record: ShortLinkRecord = {
        storagePath,
        originalName: String(raw.originalName || ""),
      };
      const list = result.get(storagePath) ?? [];
      list.push({ shortId: doc.id, record });
      result.set(storagePath, list);
    }
  }
  return result;
}

/** Delete short-link Firestore docs whose storagePath is in the given set. */
export async function deleteShortLinksForStoragePaths(
  shopDomain: string,
  paths: Iterable<string>,
): Promise<number> {
  const pathSet = new Set([...paths].map((p) => p.trim()).filter(Boolean));
  if (pathSet.size === 0) return 0;
  const map = await lookupShortLinksForStoragePaths(shopDomain, [...pathSet]);
  let deleted = 0;
  const batch = db.batch();
  for (const entries of map.values()) {
    for (const { shortId } of entries) {
      batch.delete(shortLinksCollection(shopDomain).doc(shortId));
      deleted++;
    }
  }
  if (deleted > 0) await batch.commit();
  return deleted;
}

export async function purgeDownloadShortLinks(shopDomain: string): Promise<void> {
  const col = shortLinksCollection(shopDomain);
  let snap = await col.limit(400).get();
  while (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    snap = await col.limit(400).get();
  }
}
