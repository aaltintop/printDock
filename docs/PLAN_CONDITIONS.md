# PrintDock Plan Conditions

**Date:** 2026-04-28

Source of truth: `app/config/plans.ts`

## Free (`free`)

- Max file size: 50 MB
- Max upload fields: 2
- File retention: 7 days
- Total storage cap: 500 MB
- Features:
  - basicValidation: enabled
  - advancedValidation: disabled
  - fileRenaming: disabled
  - dynamicPricing: disabled

## Starter (`starter`)

- Max file size: 100 MB
- Max upload fields: unlimited (`-1`)
- File retention: 30 days
- Total storage cap: 15 GB
- Features:
  - basicValidation: enabled
  - advancedValidation: disabled
  - fileRenaming: disabled
  - dynamicPricing: disabled

## Pro (`pro`)

- Max file size: 300 MB
- Max upload fields: unlimited (`-1`)
- File retention: 30 days
- Total storage cap: 30 GB
- Features:
  - basicValidation: enabled
  - advancedValidation: enabled
  - fileRenaming: enabled
  - dynamicPricing: enabled

## Business (`business`)

- Max file size: 5 GB
- Max upload fields: unlimited (`-1`)
- File retention: 30 days
- Total storage cap: 75 GB
- Features:
  - basicValidation: enabled
  - advancedValidation: enabled
  - fileRenaming: enabled
  - dynamicPricing: enabled

## Additional mapping rules in code

- Subscription display names:
  - Free
  - Starter
  - Pro
  - Business
- Legacy plan migration:
  - `basic_plus` -> `starter`
  - `pro_plus` -> `business`
