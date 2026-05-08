# Shopify Blueprint Reference

Reference-only material for edge cases, review risk reduction, and operational consistency.

Read this on demand. Do not consume linearly before execution.

## Pitfalls and lessons

### Reliability and webhook handling

- Shopify webhooks require fast acknowledgement; queue or defer expensive work.
- Keep Cloud Run warm for production (`min-instances=1`) unless cost goals explicitly override.
- Protect against single-record bad payloads taking down full request processing.
- Build idempotency into webhook side effects.

### Compliance and review strategy

- Decide Protected Customer Data (PCD) tier early in product design.
- Default to Level 1 unless Level 2 data is a strict product requirement.
- Keep GDPR and uninstall flows demonstrably working end-to-end.
- Make data retention/deletion behavior explicit in docs and logs.

### Pricing and packaging

- Usage/file-size limits are usually easier to understand than complex feature matrices.
- Keep free tier value real to reduce install churn and review friction.
- Keep app UI plan naming and Partner Dashboard plan naming synchronized.

### Embedded admin and storefront constraints

- Embedded apps run in an iframe on `admin.shopify.com`; cross-origin restrictions are strict.
- Use App Bridge primitives instead of parent-window assumptions.
- App proxy is the standard storefront-to-backend path; avoid direct Cloud Run calls from storefront.

### Theme and extension rollout

- Multi-template theme installs need explicit placement instructions or detection-based onboarding.
- Extension configuration drift is common; surface activation state in onboarding checks.

### Operational discipline

- Maintain a repeatable smoke-test script for every deployment.
- Keep environment bootstrap snapshots for reproducibility and recovery.
- Maintain short incident runbooks for auth failures, webhook failures, and billing mismatches.

## Submission and operations checklist topics

Use these reference topics to validate the app before submission:

- legal/compliance and privacy
- billing behavior and plan transitions
- onboarding completeness
- testing strategy and CI gates
- observability, uptime checks, and alert routing
- listing assets and reviewer test instructions

## Glossary

- `ADC`: Application Default Credentials for Google Cloud runtime auth.
- `App Bridge`: Shopify embedded app framework primitives.
- `App proxy`: HMAC-signed storefront route forwarding to app backend.
- `Managed Pricing`: Shopify-hosted subscription plan selection flow.
- `Theme app extension`: App-provided theme blocks/snippets/assets.
- `UI extension`: Targeted Shopify UI surfaces (admin, checkout, customer accounts, POS).

## Canonical references

Primary canonical source remains `SHOPIFY_APP_BLUEPRINT.md` for full detail, examples, and deep links to official Shopify/GCP docs.
