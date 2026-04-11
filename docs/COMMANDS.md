# PrintDock Commands Reference

This document lists the main commands used for local development, testing, and deployment.

## Local Development

### `npm run dev`
- Starts local app development using the project script.
- In this project, this runs `shopify app dev`.
- Use this as the default daily command.

### `shopify app dev`
- Starts Shopify app development directly via Shopify CLI.
- Equivalent to `npm run dev` in this project right now.
- Useful when you want to run CLI directly without npm scripts.

### Difference: `npm run dev` vs `shopify app dev`
- Current behavior is the same because `package.json` maps:
  - `"dev": "shopify app dev"`
- Prefer `npm run dev` for team consistency.
- Use direct `shopify app dev` for quick/manual CLI usage.

## Quality and Validation

### `npm run lint`
- Runs ESLint across the codebase.
- Use before commits and after larger refactors.

### `npm run typecheck`
- Generates route types and runs TypeScript checks.
- Helps catch type/runtime mismatches early.

### `npm run build`
- Builds the app for production.
- Run before deploy validation.

## Shopify CLI Commands

### `npm run deploy`
- Runs `shopify app deploy`.
- Use when pushing app config/extensions/functions changes.

### `npm run config:link`
- Runs `shopify app config link`.
- Links your local project to a Shopify app configuration.

### `npm run config:use`
- Runs `shopify app config use`.
- Switches active app config/environment.

### `npm run env`
- Runs `shopify app env`.
- Shows/manages Shopify app environments.

### `npm run generate`
- Runs `shopify app generate`.
- Scaffolds Shopify app components/extensions.

## Runtime / Utilities

### `npm run start`
- Starts production server from built output.
- Useful to test production runtime behavior locally.

### `npm run docker-start`
- Alias to `npm run start`.

### `npm run migrate:firestore`
- Runs Firestore hierarchy migration script.
- Use only when migration is required.
