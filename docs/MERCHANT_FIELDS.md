# PrintDock Merchant-Facing Order Fields

This document defines the line item properties PrintDock writes so merchants can operate directly from Shopify Orders.

## Scope

- Applies to line items created through the PrintDock upload flow.
- Fields appear in Shopify Admin order line item details.
- Contract owner: PrintDock app team.

## Field Dictionary

| Field | Visibility | Example | Purpose | Stability |
|---|---|---|---|---|
| `View uploads` | Merchant-facing | `https://admin.shopify.com/store/{store}/apps/printdock/app/uploads?session={session}` | Direct jump to upload session in PrintDock app. | Stable |
| `Upload session ID` | Merchant-facing | `8f963f7e-...` | Human-readable session reference for support/debugging. | Stable |
| `Artwork` | Merchant-facing | `logo-front.png` | Quick visible list of uploaded file names. | Stable |
| `__ucToken` | Merchant-facing (legacy-compatible) | `8f963f7e-...` | Legacy-style token shown on order for parity with prior workflow. | Stable |
| `__ucExp` | Merchant-facing (legacy-compatible) | `1775671200` | Session expiry as Unix epoch seconds. | Stable |
| `_pd_asset_count` | Internal/support | `1` | Count of uploaded assets tied to this line. | Stable |
| `_pd_asset_ids` | Internal/support | `asset_177567111...` | Asset identifiers for tracing files/jobs. | Stable |
| `_pd_file_quantities` | Internal/support | `[{\"fileName\":\"logo.png\",\"quantity\":1}]` | Per-file quantity map used by job pipeline. | Stable |
| `_pd_session` | Internal | `8f963f7e-...` | Session key used by pricing/function flow. | Stable |
| `_uc_session` | Internal (critical) | `8f963f7e-...` | Primary webhook/billing lookup key. | Stable |
| `_pd_field_id` | Internal | `field_...` | Upload field configuration id used during processing. | Stable |
| `_pd_calculated_price` | Internal | `29.68` | Upload-derived total used by Cart Transform pricing. | Stable |

## Operational Notes

- If `View uploads` is present, merchants can handle most routine checks without opening dashboards first.
- `_uc_session` must be present for order webhook linkage and billing recognition.
- `__ucToken`/`__ucExp` exist for merchant familiarity and migration parity.

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

## Security Guidance

- These fields are order metadata, not authorization grants.
- Do not expose raw signed file URLs in line item properties.
- `View uploads` should point to app/admin routes that apply app auth controls.
