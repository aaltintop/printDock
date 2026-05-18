# Changelog

All notable changes to **PrintDock** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version corresponds to a `vX.Y.Z` git tag on `main` and the version submitted to the Shopify App Store.

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

---

## [1.0.6] — 2026-05-18

`Print Ready File` becomes a short, clickable link inside the order's line item card. Shopify Admin auto-linkifies the value, so merchants can download directly without copy/paste or pinning a block.

### Added

- Per-shop `downloadShortLinks` Firestore collection that maps a 10-char base62 short ID to its `(storagePath, originalName)`.
- New app-proxy route `GET /apps/printdock/f/:shortId` that 302 redirects to a freshly signed Storage URL (`Content-Disposition: attachment`, 10 min TTL) on every click.
- `printdock-order-files` Admin Order Details **action** extension (auto-appears in **More actions**) opens a panel listing all uploads on the order with a Download button each.

### Changed

- `api.proxy.upload.confirm` now writes a permanent short URL into `printReadyFileUrl` (`https://{shop}/apps/printdock/f/<shortId>`) instead of the long signed-token URL.
- Theme `Print Ready File` line item property value is now ~62 characters and auto-linkifies in Shopify Admin's line item card.

### Removed

- `printdock-order-files` Admin block extension (replaced by inline clickable URL + More actions modal; no merchant pinning needed).

### Notes

- The legacy `/api/proxy/upload/file?token=…` proxy route is retained so historical orders (pre-1.0.6) keep working until their embedded 7-day token expires.

---

## [1.0.5] — 2026-05-18

One-tap download of customer uploads directly from the Shopify Admin order page.

### Added

- `printdock-order-files` Admin Order Details block extension renders tappable **Download** buttons per upload, using the `Print Ready File` line item property URL.
- English and French translations for the block.

### Changed

- Merchant download flow no longer requires copy/paste of the `Print Ready File` URL; the new block is the canonical merchant entry point on the Shopify order details page.

---

## [1.0.4] — 2026-05-18

Hide dynamic-pricing token from order line properties while keeping pricing intact.

### Changed

- Moved signed upload pricing proof from per-line `__pd_price_token` to cart attribute `__pd_price_map` keyed by `_uc_session`.
- Cart Transform now reads `__pd_price_map` + `_uc_session` and still applies `lineExpand` `fixedPricePerUnit`.
- Orders webhook verifies token from `order.note_attributes.__pd_price_map` and continues writing `pricingEvidence`.
- Line item properties remain merchant-friendly: `_uc_session`, `Artwork`, and `Print Ready File`.

---

## [1.0.3] — 2026-05-18

Cleaner cart line properties and simpler order job quantities.

### Changed

- Storefront cart uses customer-visible `Artwork` (file names) instead of `_Artwork`.
- Order webhook creates per-file jobs using the cart line quantity (no `_pd_file_quantities` map).
- `docs/MERCHANT_FIELDS.md` and `docs/MERCHANT_GUIDE.md` reflect the streamlined property list.

### Removed

- `_View uploads` admin deep-link from cart line properties.
- `_pd_file_quantities` from the theme and orders pipeline.

---

## [1.0.2] — 2026-05-18

Signed-token dynamic pricing on all Shopify plans; removes the hidden fee-product model.

### Added

- HMAC-signed `__pd_price_token` flow with app-proxy `/upload/sign` endpoint and `price-token.server.ts`.
- Rust Cart Transform function (`auto-pricing-rs`) using `lineExpand` + `fixedPricePerUnit`.
- Admin **Release notes** page entry for v1.0.2; order jobs show pricing verification anomalies.
- Cloud Build + Kaniko deploy pipeline (`cloudbuild.yaml`) and multi-stage Dockerfile with deploy metadata env vars.

### Changed

- Theme upload: single `/cart/add.js` with signed token; resets widget after add-to-cart; variant price sync.
- Onboarding **Set up upload pricing** replaces fee-product setup; cart-transform scopes required.
- Orders webhook re-verifies signed prices and stores `pricingEvidence` on upload jobs.

### Removed

- Hidden fee product service and fee-variant cart decomposition (`fee-product.server.ts`).

---

## [1.0.0] — 2026-05-08

First public release of PrintDock on the Shopify App Store.

### Added

- React Router 7 + Polaris + App Bridge embedded admin app on Cloud Run.
- Firebase Admin (Firestore + Storage) for persistence and customer-uploaded artwork.
- Shopify managed pricing with plan tiers and total-storage caps.
- Auto-pricing Cart Transform Function with per-unit and per-field pricing.
- Theme app extension for storefront upload UI and live price preview.
- Onboarding flow with auto-checks for theme blocks, billing, and required scopes.
- Privacy compliance webhooks (`shop/redact`, `customers/redact`, `customers/data_request`) plus data export and purge endpoints.
- Marketing landing page and dashboard plan card.
- Structured request logging across admin and storefront routes.

[Unreleased]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.0...v1.0.2
[1.0.0]: https://github.com/abdurrahmanaltintop/printdock/releases/tag/v1.0.0
