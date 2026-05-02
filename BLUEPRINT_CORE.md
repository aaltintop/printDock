# Shopify Blueprint Core

Core architecture and implementation defaults for app builds on this template.

## Scope

This file captures house-stack defaults and core implementation patterns. It is opinionated for consistency and speed, not universal for every Shopify app.

Use this file when implementing product behavior. Use `BLUEPRINT_EXECUTION.md` for process control and `BLUEPRINT_REFERENCE.md` for pitfalls/compliance nuances.

## House stack defaults

- Admin frontend: React Router 7 + TypeScript + Vite
- Embedded UI: Polaris + App Bridge
- Shopify SDK: `@shopify/shopify-app-react-router`, `@shopify/shopify-api`
- Data: Firestore (`firebase-admin`)
- File storage: Firebase Storage
- Hosting: Cloud Run (Docker, Node 20)
- Validation: `zod`
- Billing: Managed Pricing

## When to deviate from defaults

Consider alternatives when required by spec:

- relational-heavy reporting/analytics needs
- strict multi-region residency requirements
- high-throughput workloads where document modeling becomes a bottleneck
- existing enterprise infra standards that must be integrated

Decision alternatives and extension surface selection are defined in `SHOPIFY_APP_BLUEPRINT.md` (Decision Areas and Extension Recipes).

## Core modules every app needs

1. Shopify auth + session handling
2. Firestore-backed session storage
3. `firebase-admin` initialization
4. Required webhook handlers (`app/uninstalled`, `app/scopes_update`, billing + GDPR)
5. Billing wiring to Managed Pricing
6. Request-scoped structured logger
7. GraphQL Admin codegen wiring
8. App proxy route pattern (if storefront calls backend)
9. Setup-status/onboarding route pattern

## Configuration surface

Treat these files as primary config artifacts:

- `shopify.app.toml` (app identity/scopes/webhooks/URL)
- `.env` (local runtime)
- `.cloudrun.env` (deploy runtime)
- `BOOTSTRAP_INPUTS.local.md` (gitignored resolution snapshot)

## Plans and limits pattern

- Define plan codes as stable internal identifiers.
- Keep merchant-facing names aligned with Partner Dashboard naming.
- Prefer clear usage-based limits (for example: monthly operations, storage/file size, seats).
- Keep free tier genuinely useful.

## Webhook pattern

- Verify authenticity through Shopify SDK helpers; do not roll custom HMAC logic.
- Acknowledge quickly; defer heavy work.
- Design handlers as idempotent and safe for retries.
- Ensure uninstall and privacy deletion flows are complete and observable.

## Extension surface recipes

Common scaffolding surfaces:

- Cart Transform Function
- Theme App Extension
- Discount Function
- Admin Action / Admin Block
- Checkout UI Extension
- Web Pixel
- App Proxy

Use the long-form recipe details from `SHOPIFY_APP_BLUEPRINT.md` when implementing specific surfaces.

## Storefront and embedded integration

- For storefront-to-app calls, use app proxy pathing (`/apps/<subpath>/...`).
- For embedded admin UX, rely on App Bridge primitives and avoid cross-origin assumptions.

## App Store readiness gates

Before submission, validate:

- compliance/legal artifacts and mandatory webhooks
- billing correctness and plan mapping
- onboarding completion path
- testing strategy execution (unit, integration, route, smoke)
- observability and alerting baseline
- listing assets and reviewer instructions

See `BLUEPRINT_REFERENCE.md` for review-sensitive pitfalls and practical lessons.
