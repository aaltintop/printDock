# Observability — Cloud Logging (log-only)

PrintDock emits **one JSON object per log line** on stdout/stderr. Google Cloud Logging parses JSON automatically, so fields like `jsonPayload.event`, `jsonPayload.shopDomain`, and `jsonPayload.severity` are filterable.

There is **no** Firestore persistence for log events.

---

## Code entry points

| Area | Role |
|------|------|
| `app/lib/logger.server.ts` | `log.debug`, `log.info`, `log.warn`, `log.error`, `log.event`; `runWithRequestContext`, `setLogShopDomain`; shallow meta scrubber. |
| `app/entry.server.tsx` | SSR/stream failures use `log.error`. |
| Routes | Wrap loaders/actions with `runWithRequestContext` + `setLogShopDomain` where a shop exists; use `log.error` in `catch` and `log.event` for high-signal actions. |

---

## Log shape (example)

```json
{
  "severity": "ERROR",
  "event": "upload_session_failed",
  "message": "Maximum file count reached",
  "timestamp": "2026-04-21T12:00:00.000Z",
  "shopDomain": "some-store.myshopify.com",
  "route": "/api/proxy/upload/session",
  "method": "POST",
  "requestId": "uuid",
  "meta": { "productId": "123" },
  "error": { "name": "Error", "message": "...", "stack": "..." }
}
```

Sensitive keys in `meta` are redacted (shallow): names matching `accessToken`, `apiSecret`, `password`, `authorization`, `cookie`, `signedUrl`, `presignedUrl`, `refreshToken`, `secret`, `api_key`, `apikey`, or keys ending in `token`.

---

## Severity conventions

| Severity | When to use |
|----------|-------------|
| **DEBUG** | Verbose diagnostics (`LOG_LEVEL=debug`). |
| **INFO** | Normal operations; **`log.event`** writes INFO with `event` as the name. |
| **WARNING** | Degraded paths, validation issues, retries worth watching. |
| **ERROR** | Failures, thrown errors, **`log.error`** → stderr (Cloud Logging). |

`LOG_LEVEL` env: `debug` \| `info` \| `warn` \| `error` (default **`info`** when unset; local `.env` often uses `debug`).

---

## Event vocabulary (`log.event` and `jsonPayload.event`)

Filter in Cloud Logging: `jsonPayload.event="admin_page_view"`.

| Event | Typical meta |
|-------|----------------|
| `admin_page_view` | `{ path }` |
| `field_created`, `field_updated`, `field_soft_deleted` | field ids / labels as appropriate |
| `plan_selected`, `subscription_created`, `billing_mode_mismatch` | plan / billing context |
| `upload_session_requested`, `upload_session_failed`, `upload_confirmed`, `upload_blocked`, `upload_failed` | proxy upload flow |
| `webhook_received`, `webhook_processed`, `webhook_failed` | webhook topic / shop |
| `cron_retention_run` | summary counts (`purgedFields`, `deletedStorageObjects`, etc.) |
| `collection_id_resolve_failed` | `shopDomain`, `productId` (WARN — GraphQL collection resolver) |
| `admin_error_boundary` | admin shell SSR errors |

---

## Where to view logs (Cloud Logging)

**Console:** Logging → Logs Explorer → restrict to your Cloud Run service, e.g.:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="printdock-service"
severity>=ERROR
jsonPayload.shopDomain=~"some-store"
```

**gcloud** (recent issues by event):

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity>=WARNING AND jsonPayload.event="upload_session_failed"' \
  --limit=50 --format=json --project=YOUR_PROJECT_ID
```

**By request id** (paste from support / a single log line):

```bash
gcloud logging read \
  'jsonPayload.requestId="PASTE_UUID_HERE"' \
  --limit=20 --format=json --project=YOUR_PROJECT_ID
```

---

## Copy-for-AI triage workflow

1. Open one **ERROR** log line in Cloud Logging (raw JSON).
2. Paste the full JSON into your AI assistant.
3. The payload is self-describing: `event`, `message`, `error.stack`, `shopDomain`, `route`, `meta` (scrubbed) are enough to reason about code paths without database access.

**Good paste example (abbreviated):**

```json
{
  "severity": "ERROR",
  "event": "upload_session_failed",
  "message": "Firestore permission denied",
  "shopDomain": "demo.myshopify.com",
  "route": "/api/proxy/upload/session",
  "requestId": "…",
  "meta": { "productId": "789" },
  "error": { "name": "Error", "message": "7 PERMISSION_DENIED: …", "stack": "…" }
}
```

---

## Related docs

- Deploy and env vars: [`DEPLOY_CLOUD_RUN.md`](./DEPLOY_CLOUD_RUN.md)
- Root `.env` — `LOG_LEVEL` for local verbosity
