# Variant-based upload & dynamic upload

Merchant-facing and storefront guide for PrintDock’s two upload modes. This document covers what customers see and what merchants can configure. Implementation details are out of scope.

PrintDock uses one upload widget and one field configuration. The difference between modes is **how the customer is charged**.

| | Variant-based | Dynamic |
|---|---|---|
| Merchant toggle | **Charge using dynamic pricing** = off | = on |
| Customer pays | Normal Shopify variant price | Variant price **+** upload fee from the file |
| Calculated price in the widget | No | Yes |

---

## 1. What the storefront customer sees

### Always (both modes)

- Title and description set by the merchant
- Drop zone (e.g. “Drop your artwork here” / Choose file — labels editable in the theme)
- Hint line: allowed file types, max file size (MB), max files
- Progress states: Checking file… → Uploaded (or an error)
- Ability to remove the file and try again
- If upload is required: cannot add to cart until a valid upload succeeds
- If the file fails rules: a clear message with the measured value; add to cart stays blocked

### Variant-based only

- No “calculated upload price” block in the widget
- Checkout price is whatever the product/variant already shows in Shopify

### Dynamic only

- After a successful upload: **Calculated upload price:** (label editable in the theme)
- Breakdown style: base + upload fee, scaled by quantity
- That combined amount is what they pay at checkout
- On the order line, Shopify may show a **Part of:** row under the product (e.g. “Upload file” or the field’s storefront title)

---

## 2. Mode switch

Configured in **PrintDock → Fields → Dynamic pricing**.

| Setting | Variant-based | Dynamic |
|--------|----------------|---------|
| **Charge using dynamic pricing** | Off | On |
| Shop setup | Theme block + field | Same + **Set up upload pricing** once on Setup so checkout can apply the fee |

When off: no upload fee is added from this field.  
When on: **Rate settings** appear.

---

## 3. Shared field settings (both modes)

These settings apply whether dynamic pricing is on or off.

### Field Basics

| Setting | Details |
|--------|---------|
| **Admin title** | Name visible only in the PrintDock admin. Customers never see this. |
| **Active** | On/off. When inactive, the field does not apply on the storefront. |

### Display Target

| Setting | Details |
|--------|---------|
| **Products** | Browse and select products where the upload widget appears. |
| **Collections** | All products in selected collections automatically show this field. |
| **Set variant dimensions (inches)** | Optional width (W) and height (H) per variant. Saved for expected print size; **not enforced at upload time in the current version**. |

At least one product or collection is required.

Products and collections are combined: the field shows on any product that is selected directly or belongs to a selected collection.

### Storefront Content

| Setting | Details |
|--------|---------|
| **Storefront title** | Heading customers see above the upload widget. With dynamic pricing, this can also appear as the **Part of:** title on the order line. |
| **Description** | Helper text shown under the title. |
| **File rename pattern** | How files are renamed after an order is placed (not shown to the customer on the product page). Default: `{orderId}_{lineItemId}_{originalName}`. |

**Rename pattern tokens:**

| Token | Meaning |
|-------|---------|
| `{orderId}` | Shopify order ID (numeric) |
| `{orderName}` | Order name (e.g. #1001) |
| `{lineItemId}` | Line item ID |
| `{variantName}` | Variant title |
| `{originalName}` | File name without extension |
| `{fileIndex}` | 1-based index when multiple files |

Characters are sanitized for safe file names. The field editor shows an example filename preview.

### Content Type

| Setting | Details |
|--------|---------|
| **Restrict allowed file types** | Off = all file types accepted. On = only the types listed below. |
| Preset groups | Images (png, jpg, jpeg); PDF; SVG; Adobe (ai, psd, eps); TIFF |
| **Add custom extension** | e.g. `webp` |

When restricted, only the listed extensions are accepted. The dropzone shows the allowed types to the customer.

### File Size Rules

| Setting | Details |
|--------|---------|
| **Max file size** | Maximum size per file in MB (minimum 1). Shown to the customer on the dropzone. |

### Dimension rules

Block uploads when artwork does not meet size or DPI limits. Customers see the exact reason with their file’s measured value.

| Dimension | When available | Modes | Limits |
|-----------|----------------|-------|--------|
| **Width** (inches) | Flat and per square inch methods (not when calculation is per inch height) | Off / Fixed value / Range (min–max) | 0.01–500 in |
| **Height** (inches) | All calculation methods | Off / Fixed value / Range | 0.01–500 in |
| **DPI** | All calculation methods | Off / Fixed value / Range | 1–2400 |

Failing rules **prevent** (block) the upload.

Uploads are limited by **file size** (the merchant's max file size setting, clamped by the shop's plan) and by these **dimension rules**. There is no separate megapixel / resolution ceiling — large-format print files are accepted as long as they stay within the configured size and dimension rules.

**How dimensions are measured (merchant guidance in the editor):**

- DPI is read from PNG (pHYs) and JPEG (JFIF density). PDFs report a fixed 72 DPI.
- Files that only carry DPI in JPEG EXIF may be treated as missing DPI; customers see a clear message and can re-export with embedded DPI.
- Densities below 30 DPI are treated as missing (common placeholder).

### Values fixed by the app on the field form today

These are not editable as open merchant controls on the field editor:

| Item | Current behavior |
|------|------------------|
| Required upload (field level) | Upload is treated as required |
| Min / max files | One file per upload |
| Rounding of price dimensions | Off |

The theme block still has its own **Require upload before add to cart** setting (see below).

---

## 4. Dynamic-only settings (Rate settings)

Shown only when **Charge using dynamic pricing** is on.

| Setting | Details |
|--------|---------|
| **Calculation method** | **Flat** — fixed price per upload · **Per inch height** — fee × print height · **Per square inch** — fee × print area (width × height) |
| **Unit price** | Label depends on method: **Flat price** · **Price per inch of height** · **Price per square inch**. Range $0–$9999. Decimal comma accepted. |
| **Floor price** | Only for per inch height and per square inch. Minimum fee for an upload (`0` = no floor). Same dollar range. |

Fees are calculated from uploaded file metadata (no inferred DPI or roll-width fallback).

With dynamic pricing off (variant-based), none of these rate settings apply. The customer pays the Shopify variant catalog price only.

---

## 5. Theme editor — PrintDock Upload block

Configured in **Online Store → Themes → Customize** on the product template. Applies to the widget appearance and behavior on that template (not per field). Used for both modes.

### Behavior

| Setting | Default |
|--------|---------|
| **Require upload before add to cart** | On |
| **Enable debug logs (browser console)** | Off (for troubleshooting) |

### Colors

| Setting | Role / default |
|--------|----------------|
| Primary | Buttons, dropzone hover accent (`#111111`) |
| On primary | Text/icon on primary (`#ffffff`) |
| Success | Progress bar start (`#1f8b5c`) |
| Success (strong) | Progress bar end and success text (`#0d8246`) |
| Danger | Errors and remove icon (`#d82c0d`) |
| Warning | Warning accent (`#ffc453`) |
| Card background | Widget surface (`#ffffff`) |
| Dropzone & price background | Subdued surface (`#f4f6f8`) |
| Card border | `#e3e5e7` |
| Dropzone border | `#c9cccf` |
| Text | `#202223` |
| Text (subdued) | `#6d7175` |

### Layout

| Setting | Default / range |
|--------|-----------------|
| Corner radius | 8 px (0–24) |
| Text size | 100% (85–120) |
| Density | Regular (Compact / Regular / Roomy) |

### Text labels

| Setting | Default |
|--------|---------|
| Dropzone headline | Drop your artwork here |
| Choose button label | Choose file |
| Validating label | Checking file... |
| Uploaded success label | Uploaded |
| **Calculated price label** | Calculated upload price: |

The calculated price label is used when dynamic pricing shows a price in the widget. It has no practical effect for variant-based mode.

### Advanced

| Setting | Details |
|--------|---------|
| Custom CSS | Optional CSS overrides for the widget |

---

## 6. One-time shop setup for dynamic pricing

On **Setup** in PrintDock, use **Set up upload pricing**. This prepares the shop so the calculated upload fee can be applied at checkout (Cart Transform and related checkout setup).

- **Variant-based:** not needed for charging (price comes from the Shopify variant).
- **Dynamic:** required so the calculated fee is charged at checkout.

---

## 7. Side-by-side checklist

| Merchant setting | Variant-based | Dynamic |
|------------------|---------------|---------|
| Field basics, targets, copy, file types, max MB | Yes | Yes |
| Variant W×H (optional; not enforced on upload yet) | Yes | Yes |
| Dimension rules | Yes | Yes |
| File rename pattern | Yes | Yes |
| Charge using dynamic pricing | Off | On |
| Calculation method + unit price | — | Yes |
| Floor price | — | Height / square inch only |
| Theme block look & require upload | Yes | Yes |
| Theme “Calculated price label” | Unused in practice | Used |
| Set up upload pricing (Setup) | Not for pricing | Required for fee at checkout |

**Shopify product/variant price** is still set in Shopify Admin for both modes. Dynamic pricing **adds** an upload fee on top of that variant base.

---

## 8. Practical examples

### Variant-based

Product: “Poster” with variants priced in Shopify (e.g. A4 $29).  
PrintDock field: dynamic pricing **off**, upload required, allowed types and max size as needed.  
Customer must upload artwork and pays the variant price only.

### Dynamic

Product: “DTF Gang Sheet” (variant base may be low or zero).  
PrintDock field: dynamic pricing **on**, method **Per inch height**, unit price e.g. `$3.50`, optional floor, dimension rules as needed.  
Customer uploads artwork, sees calculated price (base + fee), and pays that combined amount at checkout.

---

## 9. After checkout (merchant view)

Relevant to both modes once an order includes an upload:

- An **Order Job** appears in PrintDock **Orders** for the uploaded line.
- Merchants can download artwork from the job or from Shopify order line properties such as **View uploads** / **__View uploads**.
- Line properties typically include artwork name and session linkage for support.
- With dynamic pricing, the Admin line may show a **Part of:** component under the product with upload details.

---

*Companion notes: storefront and field behavior only. For line-item property details see `MERCHANT_FIELDS.md`. For day-to-day operations see `MERCHANT_GUIDE.md`.*
