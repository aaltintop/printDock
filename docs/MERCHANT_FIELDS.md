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
| `Print Ready File` | Merchant + customer | `https://{shop}.myshopify.com/apps/printdock/f/AbC1d2eF34` | Short permanent URL. Shopify Admin auto-linkifies the value, so merchants click directly from the line item card and Shopify proxies the request through our app, which 302s to a fresh short-lived signed Storage URL (`attachment`). Omitted if no print-ready URL. | Stable (v1.0.6+) |
| `Artwork` | Merchant + customer | `logo-front.png` | Quick visible list of uploaded file names. | Stable (v1.0.3+; was `_Artwork`) |

## Legacy (older checkouts; may still appear on historical orders)

Some properties were removed from the theme to reduce clutter. Old orders or stale carts may still list: `__ucToken`, `__ucExp`, `"_Upload session ID"`, `_pd_session`, `_pd_asset_count`, `_pd_asset_ids`, `_pd_field_id`, `_pd_calculated_price` (pre–v1.0.2 fee-line / lineUpdate flow), `_Artwork` (pre–v1.0.3), `_View uploads`, `_pd_file_quantities`, `__pd_price_token` (pre–v1.0.4 per-line signed token), `Print Ready File` containing the long `…/api/proxy/upload/file?token=<long JWT>` URL (pre–v1.0.6). The legacy `/api/proxy/upload/file` proxy route is still served so links on historical orders continue to work until those tokens expire (7 days).

## Operational Notes

- `Print Ready File` is rendered as a clickable link directly in the order's line item card by Shopify Admin. The merchant clicks the link and is redirected to a fresh, short-lived signed Storage URL that downloads the file with the original filename.
- The short URL itself is **permanent** — it doesn't expire. Each click re-signs a 10-minute Storage URL on the fly. If the underlying file has been pruned by storage retention, the link returns `404 This file is no longer available`.
- A secondary entry point lives at **More actions → PrintDock files** on the Shopify order page (admin UI extension). It opens a modal with a Download button per upload and uses the same short URLs underneath. The action auto-appears with zero merchant setup.
- `_uc_session` must be present for order webhook linkage and billing recognition.
- Dynamic pricing proof lives in cart attribute `__pd_price_map` (Order **Additional details**, not per line item fields). Merchants don't need to act on it.
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
- `Print Ready File` is a Shopify app-proxy URL (`/apps/printdock/f/<shortId>`). Shopify signs every incoming request to the proxy, the app resolves the short ID to its mapped `(shop, storage path, original name)`, then 302 redirects to a freshly signed Storage URL with `Content-Disposition: attachment`. The Storage URL is valid for 10 minutes and is regenerated on every click.
- The short URL itself is permanent. Anyone with the URL can trigger a download as long as the underlying file still exists, so do not share order line properties or `Print Ready File` URLs in untrusted channels.
