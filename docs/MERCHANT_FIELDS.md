# PrintDock Merchant-Facing Order Fields

This document defines the line item properties PrintDock writes so merchants can operate directly from Shopify Orders.

## Scope

- Applies to line items created through the PrintDock upload flow.
- Fields appear in Shopify Admin order line item details.
- Contract owner: PrintDock app team.

## Target Admin layout (v1.0.11+)

Example on a dynamic-pricing order line (Build A):

```
Dynamic
  __View uploads: your-store.myshopify.com...    ← parent line; Admin s-internal-link (above Part of)
  Part of: Upload file                         ← Cart Transform lineExpand.title
    View uploads: https://your-store.myshopify.com/apps/printdock/f/AbC12dEf34
    __ucExp: 1779225656
    __ucToken: eyJhbGciOiJIUzI1NiJ9...
    Artwork: logo-front.png
    _uc_session: 8f963f7e-...
```

At cart add, the theme writes all keys on one cart line. **Cart Transform** copies every property except `__View uploads` onto the expanded (Part of) component via `ExpandedItem.attributes`, so `__View uploads` stays on the parent and appears **above** Part of in Admin (Upload Center parity).

`Part of:` text comes from `lineExpand.title` (default **Upload file**, or field **storefront title** in cart `_pd_price_map` as `partOfTitle`).

## Field Dictionary (current theme)

| Field | Visibility | Example | Purpose | Stability |
|---|---|---|---|---|
| `_uc_session` | App + support | `8f963f7e-...` | Primary key for webhooks, jobs, and Cart Transform. | Stable |
| `Artwork` | Merchant + customer | `logo-front.png` | Uploaded file name(s). | Stable (v1.0.3+) |
| `__View uploads` | Merchant (hidden at checkout) | `https://{shop}/apps/printdock/f/AbC1…` | **Parent line only** after transform; Admin truncated link above Part of. | Stable (v1.0.9+) |
| `View uploads` | Merchant + customer | Same short URL | On **Part of** component; full URL row. | Stable (v1.0.8+) |
| `__ucExp` | App + support | `1779225656` | Unix expiry for signed upload price (pairs with `__ucToken`). | Stable (v1.0.9+) |
| `__ucToken` | App + support | `eyJ…` | HMAC-signed price JWT (copy of cart map entry for webhook fallback). | Stable (v1.0.9+) |

## Legacy (historical orders)

| Field | Notes |
|---|---|
| `Print Ready File` | Short URL; **no longer written** on new orders (v1.0.9+). Still read by ingest and **PrintDock files** action. |
| `__pd_price_token` / per-line tokens (pre–v1.0.4) | Replaced by cart `_pd_price_map` + line `__ucToken`. |
| **PrintDock Upload Fee** line (Build B) | Second cart line pre–v1.0.8. |
| Long `…/api/proxy/upload/file?token=…` URLs | Pre–v1.0.6; proxy route still served until JWT expires. |

## Cart / order attributes (not line properties)

| Attribute | Location | Purpose |
|---|---|---|
| `_pd_price_map` | Cart + order **Additional details** | JSON `[{sid, token, partOfTitle?}]` for Cart Transform (source of truth at checkout). |

## Operational Notes

- Download: click **`View uploads`** or **`__View uploads`** in Admin, or use **More actions → PrintDock files**.
- Short URLs are permanent; each click issues a fresh signed Storage download.
- `_uc_session` + order name are enough for support correlation.
- See `docs/SPIKE_ADMIN_ORDER_LINE_PROPERTIES.md` and `docs/QA_ADMIN_ORDER_LINE_PARITY.md`.

## Troubleshooting Missing Fields

1. Verify the `PrintDock Upload` theme block is active on the product template.
2. Confirm upload succeeded before add-to-cart.
3. Check line properties for `_uc_session` and `View uploads`.
4. App logs: `orders_create_missing_uc_session`, `pricing_token_map_mismatch`, `orders_create_session_not_found`.

## Security Guidance

- Line properties are not authorization grants.
- Short links (`/apps/printdock/f/{id}`) proxy through PrintDock then 302 to time-limited Storage URLs.
- Do not share order URLs in untrusted channels.
