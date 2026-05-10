---
name: Multi-file Upload Support
overview: Enable configurable multi-file uploads end-to-end by unblocking admin field settings, aligning storefront cart properties, and hardening backend/webhook/admin behavior with tests and docs updates.
todos:
  - id: editor-min-max-files
    content: Add and validate minFiles/maxFiles controls in field editor and persist actual values
    status: pending
  - id: storefront-property-contract
    content: Align upload.js cart property contract for multi-file sessions and remove single-file ambiguity
    status: pending
  - id: api-multifile-hardening
    content: Verify and tighten session/confirm/remove endpoint behavior for multi-file edge cases
    status: pending
  - id: order-admin-consistency
    content: Validate webhook and admin job flows for multi-file sessions and fix single-asset assumptions
    status: pending
  - id: tests-multifile-lifecycle
    content: Add tests for editor, upload lifecycle, max_files overflow, and multi-job webhook outcomes
    status: pending
  - id: docs-rollout-update
    content: Update merchant docs and rollout checklist to reflect finalized multi-file behavior
    status: pending
isProject: false
---

# Multi-file Upload Implementation Plan

## Goal
Ship production-safe multi-file upload support where merchants can configure file count limits, shoppers can upload multiple files in one session, and order/admin pipelines remain consistent.

## Scope and Constraints
- Keep current session-centric model (`_uc_session`) and one-upload-session-per-line-item behavior.
- Preserve backward compatibility for single-file fields (`maxFiles=1`).
- Cap allowed file counts to a conservative upper bound (recommend 5) to limit server/storage spikes.

## Implementation Steps

### 1) Unblock multi-file configuration in admin field editor
- Update [app/routes/app.fields.$id.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/app.fields.$id.tsx) to:
  - add `minFiles` and `maxFiles` form controls,
  - validate bounds (`min >= 1`, `max >= min`, `max <= configuredUpperBound`),
  - persist real values instead of hardcoded `minFiles: 1, maxFiles: 1`.
- Keep default behavior unchanged for existing fields by defaulting to current normalized values.

### 2) Keep storefront payloads consistent for multi-file sessions
- Update [extensions/theme-extension/assets/upload.js](/Users/abdurrahmanaltintop/development/shopify/printDock/extensions/theme-extension/assets/upload.js) property emission contract:
  - retain `_uc_session` and `_Artwork` (comma-separated file names),
  - keep `_pd_calculated_price` as aggregate per-unit upload fee across successful files,
  - decide and implement one canonical print-ready strategy for multi-file (recommended: rely on `_View uploads` and stop implying single-file download semantics).
- Align public docs with exact emitted fields.

### 3) Harden upload API behavior under multi-file limits
- Validate multi-file constraints and stale-session handling consistency across:
  - [app/routes/api.proxy.upload.session.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/api.proxy.upload.session.tsx)
  - [app/routes/api.proxy.upload.confirm.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/api.proxy.upload.confirm.tsx)
  - [app/routes/api.proxy.upload.remove.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/api.proxy.upload.remove.tsx)
- Ensure limit checks are deterministic when files are uploaded sequentially in one session and when files are removed/retried.

### 4) Normalize order creation/admin read paths for multiple assets
- Keep one order job per file (already implemented) in [app/routes/webhooks.orders.create.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/webhooks.orders.create.tsx), but verify all downstream assumptions.
- Review admin views for single-asset assumptions and ensure UX remains clear when one line item yields multiple jobs:
  - [app/routes/app.orders.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/app.orders.tsx)
  - [app/routes/app.orders.$id.tsx](/Users/abdurrahmanaltintop/development/shopify/printDock/app/routes/app.orders.$id.tsx)
- Confirm data normalization behavior remains stable in [app/services/shop-data.server.ts](/Users/abdurrahmanaltintop/development/shopify/printDock/app/services/shop-data.server.ts).

### 5) Fill test gaps for multi-file lifecycle
- Add/extend tests for:
  - field editor save/validation of `minFiles`/`maxFiles`,
  - upload session + confirm overflow (`max_files`) and retry/remove flows,
  - webhook creation of N jobs from N assets in one session,
  - storefront property contract expectations for multi-file.
- Primary test locations:
  - [tests](/Users/abdurrahmanaltintop/development/shopify/printDock/tests)
  - [extensions/auto-pricing/tests](/Users/abdurrahmanaltintop/development/shopify/printDock/extensions/auto-pricing/tests)

### 6) Documentation and rollout notes
- Update merchant/property contract docs to reflect actual multi-file behavior:
  - [docs/MERCHANT_FIELDS.md](/Users/abdurrahmanaltintop/development/shopify/printDock/docs/MERCHANT_FIELDS.md)
  - [docs/MERCHANT_GUIDE.md](/Users/abdurrahmanaltintop/development/shopify/printDock/docs/MERCHANT_GUIDE.md)
- Add a short rollout checklist (recommended max file cap, QA scenarios, fallback to single-file by setting `maxFiles=1`).

## Verification Checklist
- Merchant can set `maxFiles > 1` and save successfully.
- Storefront accepts multiple files up to limit, blocks at limit, and supports remove/retry.
- Cart line properties remain valid and pricing transform still applies correctly.
- Order webhook generates one job per uploaded file without duplicates.
- Admin list/detail pages behave correctly for jobs originating from multi-file sessions.
- Existing single-file fields remain unchanged.

## Risk Control
- Feature remains config-driven per field; default remains single-file unless merchant changes settings.
- Conservative max-files cap prevents excessive validation/storage load.
- Backward compatibility maintained via existing `asset` + `assets` normalization.