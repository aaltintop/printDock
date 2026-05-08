# Test Fixtures

Sample images and PDFs that exercise every validation, pricing, and
upload-pipeline branch in PrintDock. Generated deterministically by
`scripts/generate-test-fixtures.mjs` (sharp + pdf-lib, no external CLI).

## Regenerate

```bash
npm run gen:fixtures               # full set (~245 MB total, mostly oversize/)
npm run gen:fixtures -- --skip-heavy # skip the 169 MB Starter-tier file
node scripts/verify-test-fixtures.mjs # re-read with sharp/pdf-lib and dump metadata
```

`tests/fixtures/oversize/` is gitignored — regenerate locally as needed.
`tests/fixtures/images/` and `tests/fixtures/pdfs/` are repo-safe (~7 MB total).

## Code paths under test

These fixtures target:

- `app/services/validation.server.ts` — `extractMetadata` (sharp + pdf-lib)
  and `runValidationRules`
- `app/services/pricing.server.ts` — `calculatePrice` for `inch_height`,
  `inch_square`, `flat`
- `app/routes/api.proxy.upload.confirm.tsx` — plan caps, dimension rule
  consolidation, allowed extensions, total-storage cap
- `extensions/theme-extension/assets/upload.js` — client-side preflight
  (`parsePngDpi`, `parseJpegDpi`, `parseExifDpi`, `peekImageDimensions`,
  `runRulesClient`, `MAX_PIXELS`)

## Fixture map

Each row lists the file, what sharp/pdf-lib actually reads from it, and which
validation/pricing branch the file is meant to trigger.

### A. DPI threshold (target rule: `dpi >= 300`, blocking)

| File | Reads as | Triggers |
|---|---|---|
| `A1_no_dpi_1200x1800.png` | `dpi=null` (no pHYs chunk) | DPI rule **skipped** (null actual); `widthInch`/`heightInch` rules also null → **inch-based pricing fails with `missing_dimensions`** |
| `A2_72dpi_6x9.jpg` | `dpi=72`, 6"×9" | DPI block; B-rule range block |
| `A3_150dpi_6x9.jpg` | `dpi=150`, 6"×9" | DPI block; size rules can pass |
| `A4_300dpi_6x9.jpg` | `dpi=300`, 6"×9" | DPI `gte 300` PASS; `gt 300` FAIL — exact-bound test |
| `A5_600dpi_6x9.jpg` | `dpi=600`, 6"×9" | DPI PASS; high-res happy path |
| `A6_asym_200x300dpi.jpg` | `dpi=200`, 9"×13.5" | **Important:** sharp returns the X density only. Asymmetric DPI is silently treated as 200 DPI; backend inch math is wrong relative to physical print. Documents the limitation rather than catching it. |

### B. Inch dimensions (target rules: width/height range 4–12 in, exact 4×6 fixed)

| File | Reads as | Triggers |
|---|---|---|
| `B1_300dpi_4x6.jpg` | 4"×6" @ 300 DPI | Happy path: PASS |
| `B2_150dpi_4x6.jpg` | 4"×6" @ 150 DPI | Inch rule PASS, DPI rule FAIL — combined-rule test |
| `B3_300dpi_4x6_plus1px.jpg` | 1201×1801px → 4.003"×6.003" | Float-tolerance: `eq 4` FAIL, `gte 4` PASS |
| `B4_300dpi_5x7.5.jpg` | 5"×7.5" | Range rule PASS, exact rule FAIL |
| `B5_300dpi_4x5.jpg` | 4"×5" | Aspect mismatch (height block) |
| `B6_300dpi_just_under_4x6.jpg` | 1199×1799px → 3.997"×5.997" | Lower-bound `gte 4` FAIL |
| `B7_300dpi_just_over_8x12.jpg` | 2401×3601px → 8.003"×12.003" | Upper-bound `lte 12` FAIL |

### C. Pixel-only / no DPI (target rule: `widthPx >= 1200`)

> Note: JPEG cannot represent "no DPI" — sharp/libvips falls back to 72 DPI
> even when no JFIF density is written. C-series uses PNG without a `pHYs`
> chunk so `meta.density` is genuinely `null`.

| File | Reads as | Triggers |
|---|---|---|
| `C1_1199x1799_no_dpi.png` | `dpi=null`, 1199×1799px | Pixel rule `widthPx >= 1200` FAIL; inch rules skipped |
| `C2_1200x1800_no_dpi.png` | `dpi=null`, 1200×1800px | Pixel rule PASS at exact bound |
| `C3_3000x4500_no_dpi.png` | `dpi=null`, 3000×4500px | Pixel rule PASS; pricing in `inch_*` mode FAILS with `missing_dimensions` |

### D. Decompression bomb / hard pixel cap (`MAX_PIXELS = 100_000_000`)

| File | Reads as | Triggers |
|---|---|---|
| `D1_9999_under_100MP.png` | 9999×9999 = 99.98 MP | Just under the cap — sharp accepts |
| `D2_10001_over_100MP.png` | 10001×10001 = 100.02 MP | Sharp throws `Input image exceeds pixel limit` → `extractMetadata` returns 400 |
| `D3_12000_solid_compressed.png` | 12000×12000 = 144 MP | Bomb test: tiny file (~440 KB) but exceeds pixel cap |

### E. Plan size-tier caps (gitignored, regenerated locally)

| File | Size | Triggers |
|---|---|---|
| `oversize/E_free_51mb.jpg` | ~75 MB | Free plan `maxFileSizeBytes=50MB` block; Starter+ accept |
| `oversize/E_starter_101mb.jpg` | ~169 MB | Starter `maxFileSizeBytes=100MB` block; Pro+ accept |
| _(missing)_ | _>300 MB_ | Pro plan block — produce manually if needed; sharp + 100% quality on noise input is RAM-heavy |
| _(missing)_ | _>500 MB_ | Hard cap `MAX_FILE_SIZE_MB` in `extractMetadata` → 400 — easiest to forge with `dd if=/dev/urandom of=… bs=1m count=520` then rename |

### F. MIME / format edge cases

| File | Reads as | Triggers |
|---|---|---|
| `F1_valid.png` | png 800×600 | Allowed-extension PASS |
| `F2_valid.jpg` | jpeg 800×600 (DPI=72 sharp default) | Allowed-extension PASS |
| `F3_valid.webp` | webp 800×600 | If `allowedExtensions=['png','jpg','pdf']` → block `extension not allowed` |
| `F4_valid.gif` | gif 800×600 | Same as F3 |
| `F5_valid_300dpi.tiff` | tiff 800×600 @ 300 DPI | sharp parses TIFF; advancedValidation must be enabled (Pro+) |
| `F6_fake_png_actually_jpeg.png` | sharp reports `format=jpeg` despite `.png` extension | `fileTypeFromBuffer` corrects MIME → `actualMimeType=image/jpeg` returned to caller |
| `F7_corrupt.jpg` | sharp throws `premature end of JPEG image` | `extractMetadata` returns 400 with parse-error message |
| `F8_simple.svg` | svg 100×100 | sharp parses SVG; behaviour to confirm in field rules |

### G. PDF (target rules: `pageCount`, `widthInch`/`heightInch`, advancedValidation gate)

| File | Reads as | Triggers |
|---|---|---|
| `G1_letter_1page.pdf` | 1 page, 8.5"×11", dpi=72 | Happy PDF path |
| `G2_a4_1page.pdf` | 1 page, 8.26"×11.69", dpi=72 | A4 happy path |
| `G3_a4_5pages.pdf` | 5 pages | `pageCount > 1` rule |
| `G4_encrypted` | _(README placeholder)_ | Generate with `qpdf --encrypt user owner 256 -- G2_a4_1page.pdf G4_encrypted.pdf`; `extractMetadata` opens it via `ignoreEncryption: true` |
| `G5_corrupt.pdf` | pdf-lib throws `Failed to parse invalid PDF object` | `extractMetadata` returns 400 |

> Caveat: PDFs always report `dpi=72`. If your DPI rule is `gte 300`,
> every PDF blocks unless you carve PDF out via `allowedExtensions`
> or a separate field.

## Suggested field configuration to exercise everything

```ts
{
  allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
  maxFileMB: 50,
  minFiles: 1,
  maxFiles: 2,
  pricing: {
    enabled: true,
    unitType: "inch_square",
    unitPrice: 0.25,
    minPrice: 2,
    roundingEnabled: true,
  },
  dimensionRules: [
    { dimensionType: "dpi",        operator: "gte", value: 300, action: "prevent",
      warningMessage: "Min 300 DPI required" },
    { dimensionType: "widthInch",  operator: "gte", value: 4,   action: "prevent",
      groupId: "w", warningMessage: "Min width 4 in" },
    { dimensionType: "widthInch",  operator: "lte", value: 12,  action: "prevent",
      groupId: "w", warningMessage: "Max width 12 in" },
    { dimensionType: "heightInch", operator: "gte", value: 6,   action: "warning",
      warningMessage: "Min height 6 in" },
  ],
}
```

This combination triggers every fixture above:

- **A2/A3** → DPI block
- **A4** → exact 300 DPI bound
- **A6** → asymmetric DPI silently truncated
- **B1** → full PASS happy path
- **B3/B6/B7** → inch boundary float tolerance
- **C1/C2** → no-DPI pixel-only behaviour
- **D2/D3** → pixel cap
- **E\*** → plan size cap (vary plan to test each tier)
- **F3/F4** → extension block
- **F6/F7** → MIME sniffing & corrupt parse
- **G3** → pageCount

## Quick-look smoke set

If you only have time for a handful, use these 12:

`B1`, `A2`, `A1`, `B6`, `B7`, `A6`, `D2`, `oversize/E_free_51mb`, `F6`, `F7`,
`G1`, `G3`.
