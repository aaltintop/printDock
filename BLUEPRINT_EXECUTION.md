# Shopify Blueprint Execution

Execution-first playbook for AI agents. This file is intentionally compact and should be read before implementation.

## Read order

1. `PROJECT_SPEC.md` (business WHAT)
2. This file (`BLUEPRINT_EXECUTION.md`)
3. `BLUEPRINT_CORE.md` only for the section needed by the current step
4. `BLUEPRINT_REFERENCE.md` only when blocked or validating edge cases

## Workflow loop

Use this order and keep one concern per step:

1. Pre-flight checks (auth + required CLIs)
2. Resolve bootstrap inputs (AUTO/PROPOSE/ASK)
3. Bootstrap infra
4. Apply configuration (`shopify.app.toml`, `.env`, `.cloudrun.env`)
5. Wire core modules (auth/session/webhooks/billing/logger)
6. Generate plans/limits from spec
7. Implement domain routes/services
8. Scaffold required extension surfaces
9. Implement onboarding and setup-state detection
10. Deploy to Cloud Run
11. Run `shopify app deploy`
12. Execute App Store readiness checklist
13. Hand off with smoke-test script and operator verification steps

## Bootstrap resolution protocol

Resolve each value in strict priority:

- `AUTO`: resolve silently from CLI/project state and log result
- `PROPOSE`: provide best default + 2-5 alternatives, require confirmation
- `ASK`: ask only when no reliable signal exists; never open-ended, always offer alternatives

Write all resolved values to `BOOTSTRAP_INPUTS.local.md` (gitignored) as a reproducible snapshot.

## Required pre-flight commands

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
firebase login:list
shopify version
shopify app info 2>/dev/null || true
```

If any check fails, stop and return exact remediation commands before doing any scaffold work.

## Execution guardrails

- Do not read all docs linearly; read only what the current step requires.
- Keep validation continuous: after substantive changes run `npm run typecheck` and `npm run lint`.
- Prefer idempotent operations for infra and webhook processing.
- Keep deployment and app registration separate (`Cloud Run` first, then `shopify app deploy`).
- Preserve fast rollback and reproducibility through env snapshots and documented commands.

## Entry points into core and reference docs

- Architecture, stack defaults, modules, recipes: `BLUEPRINT_CORE.md`
- Pitfalls, compliance/review lessons, glossary, references: `BLUEPRINT_REFERENCE.md`

## Canonical long-form source

For full implementation detail and complete examples, consult `SHOPIFY_APP_BLUEPRINT.md`.
