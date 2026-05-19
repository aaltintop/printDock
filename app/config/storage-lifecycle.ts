/** Days to keep confirmed-but-unordered upload blobs (cart/checkout window). */
export const CONFIRMED_CART_PROTECTION_DAYS = 14;

/** Hours before abandoning an unconfirmed upload session (no assets). */
export const UNCONFIRMED_SESSION_ORPHAN_HOURS = 2;

/**
 * GCS bucket soft-delete retention (days). Must be documented vs GDPR claims.
 * Should be >= worst-case gap between mistaken delete and late order ingest.
 */
export const GCS_SOFT_DELETE_RETENTION_DAYS = 7;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_HOUR = 60 * 60 * 1000;

export function confirmedCartProtectionExpiresAtIso(fromMs = Date.now()): string {
  return new Date(fromMs + CONFIRMED_CART_PROTECTION_DAYS * MS_PER_DAY).toISOString();
}
