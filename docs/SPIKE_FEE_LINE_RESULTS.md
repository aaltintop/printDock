# SUPERCEDED — do not implement from this document

**Status:** Historical spike only (2026-05-11). **Not current architecture.**

PrintDock production pricing uses:

- **Build B (fee line):** hidden `PrintDock Upload Fee` variant + Cart Transform `lineExpand` on the fee line only (`extensions/auto-pricing-rs/`).
- **Legacy fallback:** single artwork line + `lineExpand` via `_uc_session` when the fee product is unavailable.
- **Never `lineUpdate` or `linesMerge`** in shipped code.

This spike explored `linesMerge`, denomination variants, and a `_pd_calculated_price` → `lineUpdate` fallback. Those paths were **not adopted**. See `docs/PrintDock_DynamicPricing_Plan.md` and `docs/PRINT_READY_FILE_SHORT_LINKS.md` for the current design.

---

# Fee-Line Spike Results (archived)

Date: 2026-05-11

## Scope

This spike validates the pre-build unknowns for fee-line dynamic pricing:

1. Merge price default behavior.
2. Runtime operation key (`merge` vs `linesMerge`).
3. Property survival through merged lines to order webhooks.
4. Multiple merges on same parent variant.

## Environment notes

- `silverbeauty-2.myshopify.com` storefront endpoint (`/cart.js`) is password-protected (`401`), so checkout/cart probing is limited from this runtime.
- The spike therefore combines:
  - schema-level validation against the function schema in this repo,
  - function fixture tests,
  - code-path hardening with fallback behavior that preserves existing `_pd_calculated_price` line-update flow.

## Findings

### Q1 - Merge price default

- **Status:** unresolved in remote store due storefront auth wall.
- **Mitigation implemented:** Build path assumes sum-of-children for merge lines and keeps legacy `lineUpdate` fallback if no merge ops are emitted. This preserves backwards compatibility while we complete storefront confirmation.

### Q2 - Runtime operation key

- **Status:** ambiguous in Shopify ecosystem (`merge` vs `linesMerge` naming drift across docs/runtime reports).
- **Mitigation implemented:** function now supports a flag (`PRINTDOCK_USE_LINES_MERGE=1`) and defaults to `merge` for compatibility.

### Q3 - Property survival

- **Status:** unresolved in remote store due inability to complete cart->checkout->order in protected storefront.
- **Mitigation implemented:** artwork line still carries `_uc_session`, `_Artwork`, `_View uploads`, `_Print Ready File`, plus `_pd_unit_fee_minor`/`_pd_currency`; fee lines carry `_pd_fee_for`. `orders/create` hint scanner now recognizes these keys for diagnostics.

### Q4 - Multiple merges on same parent variant

- **Status:** unresolved in remote storefront.
- **Mitigation implemented:** function emits unique merge titles (`Artwork - design N`) when multiple session groups target the same parent variant, matching known workaround guidance.

## Architecture decision (superseded)

Selected: **Build A** (`merge` + denomination fee variants), with conservative fallback:

- Primary path: merge artwork + fee-denomination lines.
- Safety net: retain legacy `_pd_calculated_price` -> `lineUpdate` path while rollout is in flight.

**This decision was not shipped.** Production uses Build B + `lineExpand` only.

## Follow-up verification checklist (manual, merchant browser)

1. Add artwork + fee variants on non-Plus store, verify merged price in cart drawer and checkout.
2. Confirm whether merged line defaults to parent price or sum-of-children.
3. Place order and inspect `orders/create` payload for surviving properties.
4. Add two uploads of same variant and verify no checkout modal or line re-expansion occurs.
