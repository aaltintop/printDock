# Operator dashboard (`/ops`)

Internal, operator-only view of **every** client: plan, install date, plan start
date, live storage usage against the plan cap, download totals, and
month-over-month history.

This is **not** a merchant page. It lives outside the embedded app — no App
Bridge, no Polaris, no Shopify session — and is reachable only with
`OPS_DASHBOARD_SECRET`.

---

## Pages

| URL | Contents |
|-----|----------|
| `/ops` | Summary cards, monthly totals across all clients, one row per client |
| `/ops/<shop-domain>` | One client: monthly storage and download breakdown by download surface, plus the plan change trail |

Both accept `?format=json` and return exactly what the HTML renders, so the same
endpoints work for scripting.

### Query parameters

| Param | Values | Default | Meaning |
|-------|--------|---------|---------|
| `months` | `1`–`24` | `6` | Size of the history window |
| `sort` | `storage`, `downloads`, `downloadsThisMonth`, `installed`, `plan`, `shop` | `storage` | Client table order |
| `counts` | `1` | off | Also count upload sessions and order jobs per shop (two extra Firestore aggregate queries per shop) |
| `format` | `json` | HTML | Return the raw report |

---

## Access

Set `OPS_DASHBOARD_SECRET` to a long random string. **When it is unset, `/ops`
returns 401 for everyone** — the dashboard fails closed.

Three credential forms are accepted, all compared in constant time:

```bash
# curl / scripts
curl -H "Authorization: Bearer $OPS_DASHBOARD_SECRET" https://<host>/ops?format=json
curl -H "X-Ops-Secret: $OPS_DASHBOARD_SECRET"        https://<host>/ops?format=json

# browser: open https://<host>/ops and answer the Basic prompt.
# Username is ignored, password is the secret.
```

Basic auth exists so a browser can reach the page **without the secret ever
appearing in a URL, browser history, or an access log** — there is deliberately
no `?secret=` parameter.

Responses always carry `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and
`Referrer-Policy: no-referrer`.

> The shop document also stores the Shopify access token. The report reads a
> hand-picked field list and never includes it — keep it that way when adding
> columns.

---

## Required cron: daily storage snapshot

`shops/{shop}.storageUsedBytes` is only a **live counter**. Without a periodic
snapshot there is no history, so the monthly storage columns stay empty.

Schedule a **daily** HTTP `GET` (or `POST`) to:

```
https://<your-app-host>/cron/usage-snapshot
```

Auth uses `USAGE_SNAPSHOT_CRON_SECRET` if set, otherwise
`STORAGE_RETENTION_CRON_SECRET`, sent as `Authorization: Bearer <secret>` or
`X-Cron-Secret: <secret>` — same convention as the other crons.

Example with Cloud Scheduler:

```bash
gcloud scheduler jobs create http printdock-usage-snapshot \
  --schedule="15 3 * * *" \
  --time-zone="UTC" \
  --uri="https://<your-app-host>/cron/usage-snapshot" \
  --http-method=GET \
  --headers="X-Cron-Secret=<secret>" \
  --project=YOUR_PROJECT_ID
```

Run it shortly **after** `/cron/storage-retention` so each month's closing
figure reflects post-purge storage.

---

## Data model

### `shops/{shopDomain}` (fields added for ops)

| Field | Meaning |
|-------|---------|
| `downloadsTotal` | Lifetime download count across every surface |
| `lastDownloadAt` | ISO timestamp of the most recent download |
| `primaryDomain` | Merchant primary storefront host (e.g. `pineappleapparels.com`), from Shopify Admin `shop.primaryDomain` |
| `primaryDomainUpdatedAt` | ISO timestamp when `primaryDomain` was last synced |

`installedAt`, `storageUsedBytes`, and `storageUsedBytesReconciledAt` already
existed and are read as-is.

The clients table and shop detail page show both the primary website (clickable
storefront link) and the `*.myshopify.com` domain. Missing `primaryDomain`
values are backfilled on `/ops` load via the shop's offline Admin token.

### `shops/{shopDomain}/usageMonthly/{YYYY-MM}`

One document per **UTC** month. UTC so request-time writers and the cron always
agree on the bucket.

| Field | Written by | Meaning |
|-------|-----------|---------|
| `month` | both | `YYYY-MM`, duplicated as a field so range queries work |
| `downloads` | download routes | Total downloads in the month |
| `downloadsShortLink`, `downloadsProxyToken`, `downloadsAdminOrder` | download routes | Per-surface breakdown |
| `storageBytesFirst` / `storageBytesLast` | snapshot cron | Storage at the month's first / most recent snapshot |
| `storageBytesMax` | snapshot cron | Highest storage seen in the month, so spikes still register after retention frees space |
| `storageSamples` | snapshot cron | Number of snapshots taken |
| `firstSampleAt`, `lastSampleAt`, `lastDownloadAt`, `updatedAt` | both | Timestamps |

Download counters use `FieldValue.increment` in a batch. Storage snapshots run
in a transaction because `storageBytesMax` needs the previous value.

### `shops/{shopDomain}/billing/plan` (field added)

| Field | Meaning |
|-------|---------|
| `planStartedAt` | ISO timestamp when the shop started its **current** `planCode`. Preserved while the plan code is unchanged, reset on a switch, `null` with no active subscription. |

### `shops/{shopDomain}/billingHistory/{autoId}`

Append-only trail, written **only when a plan actually changes** (not on every
reconcile): `fromPlanCode`, `fromStatus`, `planCode`, `status`, `source`,
`subscriptionId`, `reconcileSource`, `changedAt`.

---

## Where download counts come from

Files are served as **short-lived signed Google Storage URLs**. Once the
redirect is handed out, the transfer happens between the client and Google —
we never see it. So the redirect handoff is the only place a download can be
counted, and every download route increments its counter right after the signed
URL is produced:

| Route | Surface | Counter field |
|-------|---------|---------------|
| `app/routes/f.$shortId.tsx` | Storefront short link | `downloadsShortLink` |
| `app/routes/api.proxy.upload.file.tsx` | Storefront HMAC token link | `downloadsProxyToken` |
| `app/routes/app.orders.$id.tsx` | Merchant admin order page | `downloadsAdminOrder` |

A counter write that fails is logged as `download_counter_increment_failed` and
swallowed — **an analytics write must never break a customer's download**. The
counts are therefore a floor, not an audited figure.

---

## Backfill expectations

These metrics start from the day the feature ships:

- **Downloads** — no history. Earlier downloads only exist as Cloud Logging
  events (`short_link_download_requested` and friends), bounded by log retention.
- **Monthly storage** — starts with the first `/cron/usage-snapshot` run.
  `avgMonthlyStorageBytes` stays `0` until one **complete** month has passed,
  because averages deliberately exclude the partial current month.
- **`planStartedAt`** — populated on each shop's next billing reconcile (admin
  load, webhook, or `/cron/billing-reconcile`), so it initially reads as the
  reconcile date rather than the true original subscription date.
- **Plan history** — empty until the first plan change after this shipped.

---

## Code map

| File | Role |
|------|------|
| `app/routes/ops.tsx` | `/ops` — resource route, owns its whole HTTP response |
| `app/routes/ops_.$shop.tsx` | `/ops/:shop` (the `ops_` prefix opts out of nesting under `/ops`) |
| `app/routes/cron.usage-snapshot.tsx` | Daily storage history writer |
| `app/services/ops-auth.server.ts` | Bearer / Basic / header secret check, 401 shaping |
| `app/services/ops-report.server.ts` | Cross-shop aggregation (bounded concurrency) |
| `app/services/ops-report.utils.ts` | Row shapes, totals, byte and percent formatting (pure) |
| `app/services/ops-usage.server.ts` | Counter and snapshot writes, month reads |
| `app/services/ops-usage.utils.ts` | Month bucketing, sample merging, averages (pure) |
| `app/services/ops-html.utils.ts` | HTML rendering with escaping (pure) |

Tests: `tests/ops-auth.test.ts`, `tests/ops-report.test.ts`,
`tests/ops-usage.test.ts`, `tests/ops-html.test.ts`.

---

## Related docs

- Deploy and env vars: [`DEPLOY_CLOUD_RUN.md`](./DEPLOY_CLOUD_RUN.md)
- Log events: [`OBSERVABILITY.md`](./OBSERVABILITY.md)
- Storage lifecycle: [`STORAGE_RETENTION_AND_DELETION.md`](./STORAGE_RETENTION_AND_DELETION.md)
- Plan limits: [`PLAN_CONDITIONS.md`](./PLAN_CONDITIONS.md)
