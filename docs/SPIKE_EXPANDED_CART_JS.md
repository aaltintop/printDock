# SPIKE: Expanded cart `/cart.js` shape (Build B)

**Date:** 2026-05-19  
**Status:** Assumption documented for embed implementation; verify on merchant store before release.

## Question

After Cart Transform `lineExpand` on the fee line, does storefront `/cart.js` still expose:

1. Line item property `_pd_fee_for` on the fee row?
2. Stable `key` matching theme DOM `data-key`?

## Working assumption (implemented in `cart-fee-ui.js`)

- Fee and artwork remain **separate line items** in `/cart.js`.
- Properties set at add time (`_pd_fee_for`, `_uc_session`) survive on their respective lines.
- Dawn uses `#CartDrawer-Item-N` / `#CartItem-N` (1-based index matching `cart.items[]` order). Some themes use `data-key="{{ item.key }}"` instead — `cart-fee-ui.js` supports both.

## Verification checklist (manual)

1. Store with Build B + dynamic pricing enabled.
2. Upload + add to cart (artwork + fee).
3. `fetch('/cart.js').then(r => r.json()).then(console.log)` in browser console:
   - Two items; fee item `properties._pd_fee_for` matches artwork `_uc_session`.
4. Open cart drawer; confirm `document.querySelector('[data-key="…"]')` finds both rows.
5. After embed enabled: one visible row + disclosure; subtotal unchanged.

## If verification fails

- Do not hide fee rows until pairing strategy is redesigned (e.g. cart attributes only, or section HTML hooks).
- Server-side Cart Validation (mode `buildB`) remains the checkout backstop.
