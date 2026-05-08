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

[Unreleased]: https://github.com/abdurrahmanaltintop/printdock/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/abdurrahmanaltintop/printdock/releases/tag/v1.0.0
