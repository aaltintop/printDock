# PrintDock Merchant-Facing Order Fields

This document defines the line item properties PrintDock writes so merchants can operate directly from Shopify Orders.

## Scope

- Applies to line items created through the PrintDock upload flow.
- Fields appear in Shopify Admin order line item details.
- Contract owner: PrintDock app team.

## Field Dictionary (current theme)

| Field | Visibility | Example | Purpose | Stability |
|---|---|---|---|---|
| `_uc_session` | App + support | `8f963f7e-...` | Primary key for webhooks, jobs, and Cart Transform “session present” check. Same UUID merchants can use for support. | Stable |
| `Print Ready File` | Merchant + customer | `https://{shop}.myshopify.com/apps/printdock/api/proxy/upload/file?token=...` | One-tap download of the stored upload via proxy + short-lived Storage URL (`attachment`). Omitted if no print-ready URL. | Stable (v1.0.3+) |
| `Artwork` | Merchant + customer | `logo-front.png` | Quick visible list of uploaded file names. | Stable (v1.0.3+; was `_Artwork`) |
| `__pd_price_token` | Internal (Cart Transform) | `eyJhbGciOiJIUzI1NiIs...` (JWT-shaped) | Short-lived HMAC-signed token encoding the calculated upload fee in shop currency minor units. Cart Transform verifies it and applies `fixedPricePerUnit` on the same line via `lineExpand`. Omitted when dynamic pricing is off or the fee is zero. Not intended for merchant action post-checkout. | Stable (v1.0.2+) |

## Legacy (older checkouts; may still appear on historical orders)

Some properties were removed from the theme to reduce clutter. Old orders or stale carts may still list: `__ucToken`, `__ucExp`, `"_Upload session ID"`, `_pd_session`, `_pd_asset_count`, `_pd_asset_ids`, `_pd_field_id`, `_pd_calculated_price` (pre–v1.0.2 fee-line / lineUpdate flow), `_Artwork` (pre–v1.0.3), `_View uploads`, `_pd_file_quantities`.

## Operational Notes

- If `Print Ready File` is present, merchants and customers can open or download the file directly from line items.
- Download token in `Print Ready File` is valid for **7 days** (Storage object lifecycle may differ).
- `_uc_session` must be present for order webhook linkage and billing recognition.
- `__pd_price_token` is required for checkout pricing logic and should be treated as internal; it is not intended for merchant-side operational use after order creation.
- For support, the store domain plus **`_uc_session` UUID** and Shopify order name are usually enough to correlate with app data.

## Troubleshooting Missing Fields

1. Verify the `PrintDock Upload` theme block is active on the product template.
2. Test the storefront flow and confirm file status is successful before add-to-cart.
3. Verify the theme uses a supported add-to-cart path (`/cart/add` or `/cart/add.js`).
4. Check order line properties for `_uc_session`:
   - If missing, webhook cannot create linked jobs for that line.
5. Check app logs for:
   - `orders_create_missing_uc_session`
   - `orders_create_session_not_found`
   - `billing_missing_uc_session`
6. If storefront proxy endpoints return 404 (`/apps/printdock/...`):
   - Run `shopify app deploy` to push latest app config.
   - Reinstall the app on the target store after proxy/config changes.
   - Confirm `shopify app dev` output includes an `app_proxy` line with a dev URL.
   - Verify `/apps/printdock/api/proxy/upload/config?...` returns `200`.

## Security Guidance

- These fields are order metadata, not authorization grants.
- `_Print Ready File` uses an app-proxy URL plus an HMAC-signed token; the response redirects to a **short-lived** signed Storage URL with `Content-Disposition: attachment`.
- Do not log or share order line properties in untrusted channels; anyone with the token can download until it expires.
