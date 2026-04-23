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
| `_Print Ready File` | Merchant (underscore) | `https://{shop}.myshopify.com/apps/printdock/api/proxy/upload/file?token=...` | One-tap download of the stored upload via proxy + short-lived Storage URL (`attachment`). Omitted if no print-ready URL. | Stable |
| `_View uploads` | Merchant (underscore) | `https://admin.shopify.com/store/{store}/apps/printdock/app/uploads?session={session}` | Direct jump to upload session in PrintDock app. | Stable |
| `_Artwork` | Merchant (underscore) | `logo-front.png` | Quick visible list of uploaded file names. | Stable |
| `_pd_file_quantities` | Pipeline | `[{\"fileName\":\"logo.png\",\"quantity\":1}]` | Per-file quantity map for order job creation. | Stable |
| `_pd_calculated_price` | Cart Transform | `29.68` | Upload-derived line total; Cart Transform reads this and `_uc_session` to apply dynamic pricing. Omitted if calculated total is not positive. | Stable |

## Legacy (older checkouts; may still appear on historical orders)

Some properties were removed from the theme to reduce clutter. Old orders or stale carts may still list: `__ucToken`, `__ucExp`, `"_Upload session ID"`, `_pd_session`, `_pd_asset_count`, `_pd_asset_ids`, `_pd_field_id`.

## Operational Notes

- If `_View uploads` or `_Print Ready File` is present, merchants can open the app session or download the file from Shopify Admin line items.
- Download token in `_Print Ready File` is valid for **7 days** (Storage object lifecycle may differ).
- `_uc_session` must be present for order webhook linkage and billing recognition.
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
