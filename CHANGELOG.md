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

[Unreleased]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.0...v1.0.2
[1.0.0]: https://github.com/abdurrahmanaltintop/printdock/releases/tag/v1.0.0
