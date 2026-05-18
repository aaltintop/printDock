---
name: Dynamic upload pricing via signed-token lineExpand
overview: Replace the broken `lineUpdate`-based dynamic pricing (Plus/dev-store-only) with a Cart-Transform `lineExpand` approach that works on every Shopify plan, requires zero hidden products in the merchant's catalog, and is structurally identical to how Upload Center solves the same problem. The calculated upload fee is encoded in an HMAC-signed JWT attached as a line attribute; the Cart Transform function verifies the signature against a per-shop secret and uses `lineExpand` with `fixedPricePerUnit` to set the cart line's displayed price.
todos:
  - id: spike
    content: "Phase 0 spike (1 day, throwaway dev branch). Build minimum end-to-end: token-signing endpoint, theme JS that attaches `_pd_price_token`, Cart Transform function emitting `lineExpand` into a same-variant ExpandedItem at a fixed price. Test on a non-Plus paid Shopify store. Capture answers to Q-keystone (same-variant expansion accepted?), Q-runtime (`expand` vs `lineExpand` name), Q-property (line attributes survive expand?), Q-multiple (multiple uploads of same variant). Document in `docs/SPIKE_LINE_EXPAND_RESULTS.md`."
    status: pending
  - id: pick_architecture
    content: Based on spike results, pick build A (same-variant lineExpand), build B (placeholder-variant lineExpand), or build C (separate fee line, no Cart Transform). Update plan + remaining todos to match. Decision criteria inline below. Implicitly Build A in code; not formally documented.
    status: pending
  - id: hmac_secret_provisioning
    content: "Build app/services/shop-secret.server.ts: generate per-shop 256-bit HMAC secret on first install, persist to Firestore at shops/{shop}/secrets.hmacKey AND mirror to a private shop metafield `printdock.hmac_secret` so the Cart Transform function can read it. Idempotent."
    status: completed
  - id: token_signing
    content: "Build app/services/price-token.server.ts: sign({shop, sessionToken, priceMinorUnits, currencyCode, expiresAt}) returns HMAC-SHA256 JWT (header.payload.signature) using shop's hmacKey. Verify function in tests mirrors what the WASM function will do."
    status: completed
  - id: cart_transform_rewrite
    content: "Rewrite extensions/auto-pricing/src/cart_transform_run.{ts,graphql}: read `_pd_price_token` from each cart line attribute, read shop's hmacKey from shop metafield via input query, verify HMAC-SHA256 in WASM (use @noble/hashes/hmac + sha256), check token's expiresAt against cart.attribute('__pd_now') (set by theme JS as a fallback time source), emit lineExpand per chosen build. Skip lines with sellingPlanAllocation. Update + add fixtures. NOTE: now two implementations exist — TypeScript (`extensions/auto-pricing`, disabled via `shopify.extension.disabled.toml`) and Rust (`extensions/auto-pricing-rs`, the active one). `exp` is NOT checked in WASM (no clock in Functions); expiry is enforced only in the order webhook."
    status: in_progress
  - id: config_endpoint
    content: Extend app/routes/api.proxy.upload.config.tsx loader. Add a new sibling endpoint `app/routes/api.proxy.upload.sign.tsx` that takes {sessionToken, priceMinorUnits} and returns a signed token. Auth via App Proxy signature (already in place).
    status: completed
  - id: theme_js_rewrite
    content: "Update extensions/theme-extension/assets/upload.js: after upload + price calc, POST to /api/proxy/upload/sign with the calculated fee, receive signed token, attach as `_pd_price_token` line property on the artwork. Single /cart/add.js call with just the artwork variant. Drop `_pd_calculated_price` and `Upload pricing` properties. No decomposition. No /cart/change interception. NOTE: `__pd_now` cart attribute is referenced in plan and merchant docs but NOT set by upload.js and NOT read by the function. Decide whether to ship `__pd_now` or remove the references."
    status: in_progress
  - id: order_webhook
    content: "Update app/routes/webhooks.orders.create.tsx: extract `_pd_price_token` from each line item's properties, verify signature, store the verified price + expiresAt + sessionToken on the OrderUploadJob doc for audit. Implemented as `pricingEvidence.anomalyReason` ('signed_price_missing' / 'signed_price_invalid_or_expired') on the OrderUploadJob doc; surfaces in app/routes/app.orders.$id.tsx. Plan also mentioned a `pricing_invalid` job status — current code does not change job status, only annotates."
    status: completed
  - id: onboarding_wiring
    content: "Pre-flight check in onboarding: query existing CartTransforms — fail loudly if a non-PrintDock transform exists. Replace 'Enable dynamic pricing' step with 'Set up upload pricing' which atomically (a) provisions HMAC secret + metafield, (b) registers Cart Transform. Remove `not_supported` Plus copy from app/routes/app.onboarding.tsx and the not_supported branch from app/services/cart-transform.server.ts. Require hmacKey doc + CartTransform registration in app/services/app-setup-status.server.ts setup-complete check."
    status: completed
  - id: docs_update
    content: "Update docs/MERCHANT_GUIDE.md: remove Shopify Plus required note; document (a) that PrintDock does not create any products in the merchant's catalog, (b) selling-plan limitation (Cart Transform skips lines with selling plans), (c) one-Cart-Transform-per-store conflict resolution, (d) recommended Discount Function exclusion if merchant runs sitewide % discounts and wants to exclude PrintDock-priced lines (provide ready-to-deploy snippet). a/b/c done. (d) Discount Function snippet still missing. docs/MERCHANT_FIELDS.md still documents legacy `_pd_calculated_price` and needs a pass."
    status: in_progress
isProject: false
---

# Dynamic upload pricing via signed-token lineExpand

## Current implementation status (May 2026)

Snapshot of how the on-disk code compares to this plan. Update on each ship.

**Built and live**

- HMAC secret service (`app/services/shop-secret.server.ts`), Firestore + app-owned shop metafield (`shopify.app.toml` → `[shop.metafields.app.hmac_secret]`).
- Token sign/verify (`app/services/price-token.server.ts`) + unit tests (`tests/price-token.test.ts`).
- App-proxy sign endpoint (`app/routes/api.proxy.upload.sign.tsx`).
- Cart Transform function (Rust) at `extensions/auto-pricing-rs/` with handle `auto-pricing`, reads `_pd_price_token`, verifies HMAC, emits `lineExpand` with `fixedPricePerUnit`. TypeScript twin at `extensions/auto-pricing/` is parked behind `shopify.extension.disabled.toml`.
- Theme `upload.js` signs the token via `/apps/printdock/api/proxy/upload/sign` and attaches `_pd_price_token` as a line property; single `/cart/add.js` call; legacy `_pd_calculated_price` removed.
- Order webhook (`app/routes/webhooks.orders.create.tsx`) re-verifies the token and writes `pricingEvidence.{hadPriceToken, tokenValid, signedMinorPerUnit, anomalyReason}` on the `OrderUploadJob`. Anomaly surfaces in `app/routes/app.orders.$id.tsx`.
- Onboarding "Set up upload pricing" step + Cart Transform conflict detection (`app/services/cart-transform.server.ts`).
- `app/services/app-setup-status.server.ts` requires HMAC secret + Cart Transform registration.
- `app/services/fee-product.server.ts` deleted; no fee variant lookups in the app or theme.
- `docs/MERCHANT_GUIDE.md` no longer claims Plus is required and documents selling-plan + Cart Transform conflict caveats.

**Gaps vs. plan**

- **Phase 0 spike not formally executed.** `docs/SPIKE_LINE_EXPAND_RESULTS.md` is still the empty template; no captured non-Plus paid-store evidence for Q-keystone / Q-runtime / Q-property / Q-multiple.
- **Architecture decision not documented.** Code commits to Build A (same-variant `lineExpand`), but there is no written decision artifact tying spike results to that choice.
- **`__pd_now` cart attribute is referenced but unused.**
  - Plan + `docs/MERCHANT_GUIDE.md` mention it.
  - `upload.js` does *not* set it. `extensions/auto-pricing-rs/src/run.graphql` does *not* read it. The Rust function comment explicitly states `exp` is not checked because Functions have no clock; expiry enforcement lives only in the order webhook.
  - Action: either implement the soft `__pd_now` write + read, or strike the references from plan + merchant guide so it stops looking half-built.
- **Order-side anomaly handling is annotation-only.** Plan mentioned setting `OrderUploadJob.status = 'pricing_invalid'`. Current code records `pricingEvidence.anomalyReason` but leaves job status alone. Confirm whether that is the intended final design or finish the status flip.
- **Two function implementations co-exist.** `extensions/auto-pricing-rs` is active; `extensions/auto-pricing` (TS) is disabled but still under git. Decide: keep both (RS prod, TS as testbed/reference) or delete the TS copy to avoid confusion.
- **`docs/MERCHANT_FIELDS.md`** still documents the legacy `_pd_calculated_price` property and should be updated to `_pd_price_token` semantics.
- **Discount Function exclusion snippet** for sitewide % codes is still missing from `docs/MERCHANT_GUIDE.md` (plan calls this V1, deferred-to-V2 note exists at the bottom).

## Why

`lineUpdate` is the only Cart Transform operation that lets you arbitrarily reprice an existing cart line, and Shopify gates it to Plus and development stores only. On every other plan it silently no-ops — the customer pays the variant's base price, not the calculated upload fee. Confirmed on `silverbeauty-2.myshopify.com`. This breaks PrintDock for >95% of its target market (print houses on Basic/Shopify/Advanced).

The fix exploits the asymmetry in `PriceAdjustment` across Cart Transform operations:

| Operation | Plus required | `fixedPricePerUnit` available |
|---|---|---|
| `lineUpdate` | yes | yes (on the operation) |
| `linesMerge` | no | **no** (only `percentageDecrease`) |
| `lineExpand` | no | **yes (on each ExpandedItem)** |

`lineExpand` is therefore the only non-Plus operation that supports arbitrary per-line repricing. Upload Center (our primary competitor) does this in production today: their cart payloads show `has_components: true` on a single repriced line, no hidden helper product in the merchant's catalog, and a JWT (`__ucToken`) carrying the calculated fee through the customer's cart.

## Architecture

```mermaid
flowchart LR
    Upload[Shopper uploads artwork] --> Calc[Server calculates fee EUR 12.42]
    Calc --> Sign["Server signs JWT: {p: 12.42, exp, session, shop}"]
    Sign --> ThemeJS[Theme JS attaches token as _pd_price_token]
    ThemeJS --> CartAdd["/cart/add.js (just the artwork variant)"]
    CartAdd --> CartTransform[Cart Transform function]
    CartTransform --> Verify[Verify HMAC against shop's secret from metafield]
    Verify --> Expand["lineExpand into ExpandedItem at fixedPricePerUnit = jwt.p"]
    Expand --> Display[Single cart line at EUR 12.42, has_components: true]
```

**Trust model.** The calculated price is computed by PrintDock's trusted backend, signed with a per-shop HMAC secret, and verified inside the Cart Transform function (which can read shop metafields but cannot make network calls). The customer's browser passes the signed token through unmodified; tampering invalidates the signature; the function falls back to the variant's base price (or rejects the line) on invalid/expired tokens. This is identical to how Upload Center's `__ucToken` works.

**Order-side integrity.** Cart Transform runs only in cart/checkout. The order's webhook payload contains the line item with its properties (including `_pd_price_token`), which `webhooks.orders.create.tsx` re-verifies and persists. Stale or invalid tokens at order time get flagged for merchant review rather than auto-rejecting the (already-paid) order.

## Phase 0: Spike — narrow, but still mandatory

Throwaway branch + a real non-Plus paid Shopify store. Output goes into `docs/SPIKE_LINE_EXPAND_RESULTS.md`. Three of these matter; one is the keystone.

### Q-keystone: Does `lineExpand` accept `merchandiseId` equal to the parent line's variant?

Setup: One real artwork product (e.g. variant `gid://shopify/ProductVariant/12345` at €5). Customer adds it to cart with a `_pd_price_token` attribute containing a signed price of €12.42. Function emits:

```ts
{ lineExpand: {
    cartLineId: artworkLine.id,
    expandedCartItems: [{
      merchandiseId: artworkLine.merchandise.id, // SAME variant as parent
      quantity: artworkLine.quantity,
      price: { adjustment: { fixedPricePerUnit: { amount: "12.42" }}}
    }],
    title: artworkLine.merchandise.product.title,
}}
```

Capture from `/cart.js` and from checkout `total_price`:

- **(a) Cart shows €12.42, `has_components: true`** → Build A is alive. This matches Upload Center's observed behavior.
- **(b) Shopify rejects the operation** ("cannot expand into self" or similar) → Build A is dead, switch to Build B (single placeholder variant).
- **(c) Cart shows €5 (parent's price) or some other unexpected value** → escalate, document, fall to Build B.

### Q-runtime: `expand` vs `lineExpand` operation name

The same docs-vs-runtime mismatch that plagued `merge` vs `linesMerge` (Aug–Oct 2025 community reports) may apply to expand. Build the spike function emitting both names behind a config flag against the current pinned API version. Whichever Shopify accepts is the constant baked into production.

### Q-property: Do line attributes survive `lineExpand` at order creation?

Convert the spike cart to a real order via Bogus Gateway. Inspect the `orders/create` webhook payload. We need `_pd_price_token`, `_uc_session`, `_View uploads`, `_Artwork`, `_Print Ready File` to all survive on the resulting order line item — otherwise the ops center loses its lookup keys. If properties get stripped, write the session token into a `cart.attribute` instead and reshape the ops center lookup.

### Q-multiple: Two artworks of the same variant in one cart

Add two separate artwork sessions of the same product variant to one cart, each with its own `_pd_price_token`. Function emits two separate `lineExpand` operations, each targeting a different `cartLineId`. Verify both lines render at their independent prices. Unlike `linesMerge`'s multi-parent-variant bug, separate `lineExpand` ops target distinct lines and should not conflict — but verify before relying on it.

### Spike infrastructure note

`printdock-test-store-1.myshopify.com` is a Partners dev store, which gets Plus-tier Cart Transform behavior — **not representative of non-Plus production behavior**. Q-keystone must run on a real non-Plus paid store. If we don't have one, provision a cheapest-tier Basic store ($29/month for one cycle) specifically for spike + ongoing non-Plus regression testing.

### Decision matrix

| Q-keystone | Q-runtime | Q-property | Q-multiple | Build |
|---|---|---|---|---|
| (a) accepted | resolves | properties preserved | independent ops work | **A**: same-variant lineExpand |
| (b) rejected | resolves | preserved | independent ops work | **B**: placeholder-variant lineExpand |
| (c) or any (b)/property failure | any | any | any | **C**: separate fee line, no Cart Transform |

## Build A (default — same-variant lineExpand)

### A.1 Per-shop HMAC secret

New service `app/services/shop-secret.server.ts`:

```ts
ensureHmacSecret(admin, shopDomain) -> { hmacKey: string }
```

- Generates a 256-bit random key on first install if absent.
- Persists to Firestore at `shops/{shopDomain}/secrets.hmacKey`.
- Mirrors to a private shop metafield `printdock.hmac_secret` (namespace `printdock`, key `hmac_secret`, type `single_line_text_field`, access `private` — readable by Functions only, not by the storefront or other apps).
- Called from the onboarding "Set up upload pricing" step before Cart Transform registration.
- Idempotent: if Firestore + metafield both already have a value and they match, no-op. If they desync, Firestore wins and overwrites the metafield.

### A.2 Token signing

New service `app/services/price-token.server.ts`:

```ts
type TokenPayload = {
  shop: string;            // shop domain, prevents cross-shop replay
  sid: string;             // session token (= _uc_session value)
  p: number;               // price in minor units (integer), e.g. 1242 for €12.42
  c: string;               // ISO currency code
  exp: number;             // unix seconds, ttl ~ 24h
  iat: number;             // unix seconds
};

signPriceToken(payload: TokenPayload, hmacKey: string): string  // returns base64url JWT
verifyPriceToken(token: string, hmacKey: string, now: number): TokenPayload | null
```

JWT structure: `base64url(header).base64url(payload).base64url(hmac_sha256(header.payload, hmacKey))`. Header is the fixed `{"alg":"HS256","typ":"JWT"}`. Payload uses short field names (`p`, `c`, `sid`, `exp`, `iat`, `shop`) to keep the token compact — line item properties have a 255-character soft limit and large carts can hit `/cart/add` URL length limits.

Used by `api.proxy.upload.sign.tsx` (signing) and `webhooks.orders.create.tsx` (re-verification). Same code is ported to WASM for the function (next section).

### A.3 Cart Transform function

`extensions/auto-pricing/src/cart_transform_run.graphql`:

```graphql
query CartTransformRunInput {
  shop {
    metafield(namespace: "printdock", key: "hmac_secret") { value }
  }
  cart {
    lines {
      id
      quantity
      merchandise { ... on ProductVariant { id } }
      sellingPlanAllocation { sellingPlan { id } }
      priceToken: attribute(key: "_pd_price_token") { value }
      session: attribute(key: "_uc_session") { value }
    }
    attribute(key: "__pd_now") { value }  // theme-provided client timestamp, see A.4
  }
}
```

`extensions/auto-pricing/src/cart_transform_run.ts`:

1. Read `shop.metafield.value` as the HMAC key. If missing, return `{ operations: [] }` (graceful no-op — app not fully onboarded yet).
2. Parse `cart.attribute.__pd_now` as `now` (unix seconds). If missing or > 5 minutes in the past/future from the function's deterministic "no time" baseline, use the token's `iat` + a max age (treat-as-fresh) — see A.3.1 for the deterministic clock-skew approach.
3. For each cart line:
   - Skip if `sellingPlanAllocation` present (Shopify rejects expand on selling-plan lines).
   - Skip if no `priceToken` attribute.
   - Call `verifyPriceToken(line.priceToken.value, hmacKey, now)`:
     - If signature invalid → skip (line keeps base price; flag for telemetry on the order side).
     - If `payload.shop !== input.shop.domain` → skip (cross-shop replay attempt).
     - If `payload.exp < now` → skip.
   - Emit:
     ```ts
     { lineExpand: {
         cartLineId: line.id,
         expandedCartItems: [{
           merchandiseId: line.merchandise.id,
           quantity: line.quantity,
           price: { adjustment: { fixedPricePerUnit: {
             amount: (payload.p / 10 ** currencyDecimals(payload.c)).toFixed(currencyDecimals(payload.c))
           }}}
         }],
     }}
     ```

WASM dependencies: `@noble/hashes/hmac` and `@noble/hashes/sha256`. Both are ~3KB minified, well under Cart Transform's 256KB code limit. Base64url decode is ~30 lines of WASM-friendly TypeScript.

#### A.3.1 The clock-skew problem and `__pd_now`

Cart Transform functions are deterministic — no system time, no network calls. They cannot independently check `exp < now`. Two workarounds:

- **Soft approach (V1)**: theme JS sets `cart.attribute.__pd_now` to `Math.floor(Date.now() / 1000)` on every cart-add and cart-change. The function reads it. Customer can theoretically tamper with this client-side, but to extend an expired token they'd have to set `__pd_now` to a past value, which would also invalidate any other concurrent items — and the worst case is they replay a 24-hour-old token, which still came from our signed server.
- **Hard approach (V2 if abuse becomes real)**: server-side expiration check in `webhooks.orders.create.tsx` against the order's `created_at`. If the token expired before order creation, flag the order with `pricing_invalid` and surface in the ops center for merchant decision.

V1 ships the soft approach. The hard approach is implemented in `order_webhook` todo regardless, so the audit trail is correct even if a customer hand-crafts an old `__pd_now`.

Fixtures: `expand-valid-token.json`, `expand-invalid-signature.json`, `expand-expired.json`, `expand-cross-shop.json`, `expand-no-token.json`, `expand-skip-selling-plan.json`, `expand-multiple-uploads-same-variant.json`.

### A.4 Theme JS — drastically simpler

`extensions/theme-extension/assets/upload.js`:

```js
// After upload + price calc:
const signRes = await fetch('/apps/printdock/api/proxy/upload/sign', {
  method: 'POST',
  body: JSON.stringify({
    sessionToken: ucSessionToken,
    priceMinorUnits: calculatedFeeMinorUnits,
  }),
});
const { token, expiresAt } = await signRes.json();

// On cart-add (single call, just the artwork):
await fetch('/cart/add.js', {
  method: 'POST',
  body: JSON.stringify({
    items: [{
      id: artworkVariantId,
      quantity: productQuantity,
      properties: {
        _uc_session: ucSessionToken,
        _pd_price_token: token,
        _View_uploads: viewUrl,
        _Artwork: artworkFilename,
        _Print_Ready_File: printReadyUrl,
      },
    }],
  }),
});

// Set cart attribute for the function's clock (cheap, runs once per add):
await fetch('/cart/update.js', {
  method: 'POST',
  body: JSON.stringify({ attributes: { __pd_now: String(Math.floor(Date.now() / 1000)) }}),
});
```

Dropped from current implementation: `_pd_calculated_price`, `Upload pricing` visible property, `decomposeFee`, fee-variant lookups, `/cart/change` interception, qty lock workaround. **All of it.**

Quantity changes work natively: `lineExpand` runs on every cart read with the current `line.quantity`, and the price adjustment is `fixedPricePerUnit` so the line price scales correctly with quantity. No theme-side intervention needed.

### A.5 Order webhook re-verification

`app/routes/webhooks.orders.create.tsx`:

```ts
for (const line of order.line_items) {
  const props = parseLineItemProperties(line.properties);
  if (!props._pd_price_token) continue;

  const hmacKey = await getShopSecret(shopDomain);
  const payload = verifyPriceToken(
    props._pd_price_token,
    hmacKey,
    Math.floor(new Date(order.created_at).getTime() / 1000),
  );

  await db.collection(`shops/${shopDomain}/orderUploadJobs`).doc(...).set({
    // ...existing fields...
    pricingEvidence: {
      tokenValid: payload !== null,
      verifiedPriceMinorUnits: payload?.p ?? null,
      verifiedCurrency: payload?.c ?? null,
      tokenIssuedAt: payload?.iat ?? null,
      tokenExpiresAt: payload?.exp ?? null,
      actualLinePrice: line.price,
      anomaly: payload && line.price !== formatPrice(payload.p, payload.c)
        ? 'price_mismatch'
        : !payload
          ? 'pricing_invalid'
          : null,
    },
  });
}
```

If `anomaly` is non-null, the ops center surfaces a yellow banner on the order: "This order's upload fee couldn't be verified. Review before fulfillment." Doesn't block the order — the customer already paid — but flags for merchant review.

### A.6 Onboarding

`app/routes/app.onboarding.tsx` + `app/services/cart-transform.server.ts`:

- Pre-flight: query `cartTransforms(first: 25)`. If a non-PrintDock transform exists, hard-error in onboarding with a clear "Conflict: [App Name] is already using your store's Cart Transform slot. Shopify allows one per store. Uninstall [App Name] or contact PrintDock support."
- Rename step "Enable dynamic pricing" → "Set up upload pricing".
- The step's action atomically: `ensureHmacSecret` → register Cart Transform → verify the metafield is readable (test query). If any sub-step fails, roll back.
- Delete the `not_supported` plan-gating copy at `app/routes/app.onboarding.tsx` lines 321–327.
- Delete the `not_supported` branch in `app/services/cart-transform.server.ts`.
- Add `hmacKey` presence + `cartTransform.id` presence to `isAppSetupComplete` in `app/services/app-setup-status.server.ts`.

### A.7 Migration from current implementation

- Existing dev/Plus installs running `lineUpdate`: deploying the new function wasm replaces the function code under the same handle. Cart Transform registration stays. Carts re-process on next read.
- In-flight non-Plus carts with the old `_pd_calculated_price` property: were already paying base price (the bug we're fixing). After deploy, those carts continue to pay base price until the shopper refreshes the PDP and re-uploads. No price regression — they were never paying correctly to begin with.
- No data migration needed. No Firestore schema changes beyond adding `secrets.hmacKey` and per-order `pricingEvidence`.

## Build B (fallback — placeholder variant if same-variant expand rejected)

If Q-keystone returns (b) (Shopify rejects same-variant expansion), pivot to a single placeholder variant:

- `app/services/fee-product.server.ts` creates one hidden product "PrintDock Upload Fee" with one variant at €0.00, persisted to `shops/{shop}/feeProduct`. Product hidden via `templateSuffix: "printdock-fee"` (404 PDP), `seo.title: ""`, `seo.description: ""`, no collections.
- Theme JS adds artwork + 1 placeholder fee variant (with `_pd_fee_for: sessionToken` and `_pd_price_token` on the fee line, not the artwork).
- Cart Transform `lineExpand`s the placeholder fee line into one ExpandedItem at the signed price.
- Optionally `linesMerge` the artwork + expanded fee line into one displayed line — but this re-introduces the merge-price-defaulting uncertainty, so default to leaving them as two visible lines.

Pros over A: works if same-variant expand is rejected.
Cons: introduces one hidden product per shop; merchant sees two lines per upload (or has to trust merge); `app/uninstalled` cleanup needed (archive, not delete).

## Build C (worst case — no Cart Transform)

If all expand operations prove unworkable, add two cart lines directly: real artwork variant + a placeholder fee variant priced via Shopify draft order at the calculated amount (or use the same placeholder variant from Build B at €0 and accept that the fee cannot be displayed — the merchant manually invoices the difference via Shopify's order edit). This is a degraded V1 surfaced as a non-Plus limitation in the merchant guide.

Almost certainly avoidable — Upload Center proves the same-variant or placeholder-variant lineExpand approach works in production today. Build C exists only as the worst-case checkpoint.

## Issues raised in prior review and how this plan addresses them

| # | Issue | Resolution |
|---|---|---|
| 1 | linesMerge price default unverified | **Eliminated**: we don't use linesMerge. |
| 2 | merge vs linesMerge runtime mismatch | Same mismatch may exist for expand vs lineExpand — Q-runtime in the spike resolves it. |
| 3 | Properties may not survive merge | We use lineExpand, not merge. Q-property verifies expand preserves them (expected yes since the line keeps its identity). |
| 4 | Multi-merge-same-parent bug | **Eliminated**: separate expand ops target separate cartLineIds, no parent-variant collision. |
| 5 | Denomination set complexity | **Eliminated**: no decomposition, no denominations, no fee math in the function. |
| 6 | Currency precision | Server signs `p` as integer minor units + currency code; function formats correctly. Three lines of code. |
| 7 | Discounts/taxes on fee lines | **Mostly eliminated**: there's only one line (the artwork) with the dynamic price; discounts apply normally to it. Merchant guide documents how % discount codes interact (they reduce the dynamic price too, which is usually correct behavior). |
| 8 | Hidden product not actually hidden | **Eliminated in Build A**: no hidden product. (Still applies in Build B fallback, documented honestly.) |
| 9 | Cart-drawer qty lock | **Eliminated**: lineExpand re-applies fixedPricePerUnit on every cart read at the current quantity, so qty changes work natively. |
| — | Orphaned product after uninstall | **Eliminated in Build A**: nothing to clean up. (Build B archives placeholder on uninstall.) |
| — | Selling plans break the transform | A.3 step 3 skips lines with `sellingPlanAllocation`. |
| — | One-transform-per-store conflict | A.6 pre-flight check surfaces conflict in onboarding. |
| — | Multi-currency rounding | Eliminated: function formats `p / 10^decimals` once, no per-line summing. |
| — | Token tampering | HMAC-SHA256 signature with per-shop secret stored in private shop metafield; cross-shop replay blocked by `payload.shop` check. |
| — | Token replay (expired) | `exp` in payload + `__pd_now` cart attribute (V1 soft); order webhook re-verification flags anomalies for merchant review (V1 hard). |
| — | Function clock-skew | A.3.1 documents the `__pd_now` approach + order-side fallback. |
| — | App not fully onboarded edge case | Function returns `{ operations: [] }` if `hmac_secret` metafield is missing. Cart falls back to variant base price; no broken cart UX. |

## Files touched

- New: `app/services/shop-secret.server.ts`
- New: `app/services/price-token.server.ts`
- New: `app/routes/api.proxy.upload.sign.tsx`
- New: `docs/SPIKE_LINE_EXPAND_RESULTS.md` (spike output)
- New: `extensions/auto-pricing/tests/fixtures/expand-*.json` (7 fixtures)
- Modified:
  - `extensions/auto-pricing/src/cart_transform_run.graphql` (read metafield, read priceToken attribute)
  - `extensions/auto-pricing/src/cart_transform_run.ts` (rewrite: HMAC verify + lineExpand emit)
  - `extensions/auto-pricing/shopify.extension.toml` (add `shopify.shop` to input query if not already present)
  - `extensions/auto-pricing/package.json` (add `@noble/hashes` dependency)
  - `extensions/theme-extension/assets/upload.js` (signing fetch + simplified cart-add + `__pd_now` attribute; remove decomposition + qty-lock logic if either was added in prior iterations)
  - `app/routes/api.proxy.upload.config.tsx` (no longer needs to return fee variant data)
  - `app/routes/app.onboarding.tsx` (replace "Enable dynamic pricing" step; remove Plus copy)
  - `app/services/cart-transform.server.ts` (drop `not_supported` branch)
  - `app/services/app-setup-status.server.ts` (require hmacKey + cartTransform.id)
  - `app/services/pricing.server.ts` (return integer minor units, call signPriceToken)
  - `app/routes/webhooks.orders.create.tsx` (re-verify tokens, write pricingEvidence)
  - `app/routes/app.orders.tsx` (surface pricingEvidence anomalies)
  - `docs/MERCHANT_GUIDE.md` (remove Plus note; add Cart Transform conflict guidance + Discount Function exclusion snippet)
- Deleted (relative to prior plan iterations that proposed these):
  - Any reference to denomination fee variants
  - Any `decomposeFee` logic
  - `/cart/change` interception
  - `data-pd-locked` qty-lock workaround

## What this plan is not

- It is not a guess. Upload Center is shipping this exact architecture (minus implementation details we can't see) in production against `silverbeauty-2.myshopify.com` today. We have cart.js payloads showing `has_components: true`, a `__ucToken` JWT carrying the fee, and no hidden fee product in their catalog. We are adopting a known-working pattern.
- It is not Plus-dependent at any layer. `lineExpand`, metafield reads in Functions, and `cartTransform.create` are all available on every paid Shopify plan.
- It is not waiting on Shopify roadmap changes. Every API surface used here has been generally available since at least 2024-07.

## Open questions deferred to V2

- **Discount Function bundle**: ship a small companion Discount Function that excludes PrintDock-priced lines from sitewide % codes, gated by a merchant opt-in toggle in onboarding. V1 documents the manual snippet; V2 productizes it.
- **Token format upgrade**: HS256 JWT is fine for V1; if signature size matters (256 chars in property value), consider a custom compact format. Not blocking.
- **Multi-region presentment**: if a shop sells in markets with auto-converted currencies, our token's `c` field locks to shop currency at sign time. Shopify converts the displayed price per market. Spot-check during spike whether `fixedPricePerUnit` in shop currency converts correctly to presentment currency at checkout.
