# Storage retention and deletion (three layers)

Based on the retention cron, uninstall webhook, and Firestore models, there are **three deletion mechanisms** that work together.

---

## Three-layer deletion system

### Layer 0 — orphan upload sweep (short TTL)

Before normal plan-based retention runs, the cron executes an orphan sweep for sessions that were uploaded but never converted to orders.

- Scope: session statuses `active`, `success`, or `blocked` (never `converted`)
- Condition:
  - **Confirmed uploads** (`success` / `blocked`): `expiresAt` has passed (default **14 days** after confirm — see `CONFIRMED_CART_PROTECTION_DAYS`)
  - **Unconfirmed** (`active`, no assets): `createdAt` older than ~2 hours
- **Never deletes** paths under `uploads/{shop}/orders/` or session blobs still needed for a pending order ingest (no verified order copy yet)
- **May delete** redundant session blobs when a job already has a verified order copy at `assetSnapshot.storagePath`
- Action:
  1. delete eligible storage objects (and matching `downloadShortLinks` docs)
  2. delete session asset subcollection docs
  3. delete the session document itself (nested + legacy)

### Order ingest (async)

`orders/create` enqueues work to `orderIngestQueue` and returns immediately. A separate cron ([`app/routes/cron.order-ingest.tsx`](../app/routes/cron.order-ingest.tsx)) claims items with lease/retry/dead-letter semantics and copies files to `uploads/{shop}/orders/{orderId}/…`.

### GCS soft-delete backstop

When enabled on the bucket, deleted objects may remain restorable for **`GCS_SOFT_DELETE_RETENTION_DAYS`** (default 7). This is a technical tail distinct from merchant-facing `fileStorageDays`; document in privacy/GDPR materials if required.

### Layer 1 — Firebase Storage (actual file bytes)

Physical files are removed from Firebase Storage by the **storage retention** logic in [`app/services/storage-retention.server.ts`](../app/services/storage-retention.server.ts), invoked on a schedule from [`app/routes/cron.storage-retention.tsx`](../app/routes/cron.storage-retention.tsx). It:

1. Iterates upload sessions (and related job paths) per shop.
2. Anchors each `storagePath` to the oldest relevant `createdAt` and compares it to the shop’s effective plan **`fileStorageDays`** (see [`app/config/plans.ts`](../app/config/plans.ts) — e.g. Free & Starter: 7 days; Pro & Business: 30 days).
3. When expired — deletes the object in Firebase Storage for that path.
4. Then calls **`stripExpiredAsset()`** in the same file, which **does not delete the Firestore document** — it clears file pointers and sets **`storageExpired: true`**, **`storagePath` empty**, and zeroes size where appropriate so the UI can show “file no longer stored” while keeping historical metadata (filename, dimensions, dates, etc.).

So after retention runs: **the file is gone from Storage, but the Firestore row still exists** with metadata intact.

---

### Layer 2 — Firestore documents (metadata)

Firestore under `shops/{shopDomain}/` is removed when the merchant **uninstalls** the app. The [`app/routes/webhooks.app.uninstalled.tsx`](../app/routes/webhooks.app.uninstalled.tsx) webhook calls **`purgeShopStorageAndFirestore()`** from [`app/services/storage-retention.server.ts`](../app/services/storage-retention.server.ts), which:

1. Deletes all Storage objects under `uploads/{shopDomain}/` (shop prefix).
2. Calls internal **`purgeShopFirestore(shopDomain)`**, which batch-deletes nested collections (sessions, jobs, fields, caches, etc.) and legacy top-level collections that referenced the shop.

Uninstall cleanup runs only as part of GDPR / full shop teardown (not the daily retention cron).

---

## Why this two-layer design?

```text
Upload happens
     │
     ▼
File lives in Firebase Storage
Metadata lives in Firestore
     │
     ▼ (after fileStorageDays from plan)
Retention cron runs
→ Deletes file from Storage
→ Sets storageExpired = true in Firestore
→ Clears storagePath in Firestore
→ Metadata stays (order / job history preserved)
     │
     ▼ (only on uninstall)
purgeShopStorageAndFirestore()
→ Deletes Storage prefix + all shop Firestore subtree (and legacy docs)
```

---

## Why this matters for storage accounting

After the retention cron runs, a Firestore asset or job snapshot may still carry **`sizeBytes`** (and other fields) even though the blob is gone from Storage. Any aggregate that sums **`sizeBytes`** for “current storage used” **must** treat those rows as non-billable / non-counting storage, for example by skipping assets where:

- **`storageExpired === true`**, or  
- **`storagePath`** is empty / missing,

depending on the shape of the document you are scanning.

Without that guard, reported usage can include **bytes for files that were already deleted from Storage**, which misleads merchants and any plan-based storage limits you add later.

---

## Related code

| Piece | Location |
|-------|-----------|
| Retention + orphan sweep + `stripExpiredAsset`, `purgeShopFirestore`, `purgeShopStorageAndFirestore` | [`app/services/storage-retention.server.ts`](../app/services/storage-retention.server.ts) |
| Scheduled HTTP entry | [`app/routes/cron.storage-retention.tsx`](../app/routes/cron.storage-retention.tsx) |
| Uninstall purge | [`app/routes/webhooks.app.uninstalled.tsx`](../app/routes/webhooks.app.uninstalled.tsx) |
| Plan retention days | [`app/config/plans.ts`](../app/config/plans.ts) (`fileStorageDays`) |
| UI when file expired | e.g. [`app/routes/app.orders.tsx`](../app/routes/app.orders.tsx) (`storageExpired` / `storagePath`) |
