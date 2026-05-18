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
  return {
    storagePath: String(raw.storagePath || ""),
    originalName: String(raw.originalName || ""),
  };
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
): string {
  return `https://${shopDomain}/apps/printdock/f/${shortId}`;
}
