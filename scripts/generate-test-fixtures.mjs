/**
 * Generate test image / PDF fixtures that exercise every validation branch in
 * `app/services/validation.server.ts`, `app/services/pricing.server.ts`, and
 * the client preflight in `extensions/theme-extension/assets/upload.js`.
 *
 * No external CLI dependencies — uses only `sharp` and `pdf-lib` which are
 * already in package.json.
 *
 * Output layout:
 *   tests/fixtures/
 *     images/   – small, repo-safe sample images (committed)
 *     pdfs/     – PDF samples (committed)
 *     oversize/ – large files that exceed plan / hard caps (gitignored)
 *
 * Run with: npm run gen:fixtures
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests/fixtures");
const IMG = join(FIXTURES, "images");
const PDF = join(FIXTURES, "pdfs");
const BIG = join(FIXTURES, "oversize");

for (const dir of [FIXTURES, IMG, PDF, BIG]) {
  mkdirSync(dir, { recursive: true });
}

const generated = [];
function record(absPath) {
  const size = statSync(absPath).size;
  generated.push({ path: relative(ROOT, absPath), size });
}

/**
 * Produce a buffer of `widthPx × heightPx` filled with a deterministic gradient
 * so JPEGs do not compress all the way to a few bytes.
 */
function rgbGradient(widthPx, heightPx, channels = 3) {
  const buf = Buffer.alloc(widthPx * heightPx * channels);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const i = (y * widthPx + x) * channels;
      buf[i] = (x * 255) / widthPx;
      buf[i + 1] = (y * 255) / heightPx;
      buf[i + 2] = ((x + y) * 255) / (widthPx + heightPx);
      if (channels === 4) buf[i + 3] = 255;
    }
  }
  return buf;
}

/**
 * Build a plain solid-colour buffer (cheap; tiny when PNG-encoded). Used for
 * decompression-bomb tests where we want huge dimensions but small file size.
 */
function solidBuffer(widthPx, heightPx, [r, g, b] = [255, 255, 255], channels = 3) {
  const buf = Buffer.alloc(widthPx * heightPx * channels);
  for (let i = 0; i < buf.length; i += channels) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    if (channels === 4) buf[i + 3] = 255;
  }
  return buf;
}

/**
 * High-entropy noise to defeat JPEG compression — needed for E_* size-tier
 * fixtures so the output bytes actually exceed the plan caps.
 */
function noiseBuffer(widthPx, heightPx, channels = 3) {
  const buf = Buffer.allocUnsafe(widthPx * heightPx * channels);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

async function makeImage({
  outPath,
  widthPx,
  heightPx,
  format, // 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff'
  dpi = null, // number or null
  fill = "gradient", // 'gradient' | 'solid' | 'noise'
  channels = 3,
  jpegQuality = 92,
}) {
  let raw;
  if (fill === "solid") raw = solidBuffer(widthPx, heightPx, [255, 255, 255], channels);
  else if (fill === "noise") raw = noiseBuffer(widthPx, heightPx, channels);
  else raw = rgbGradient(widthPx, heightPx, channels);

  let pipeline = sharp(raw, {
    raw: { width: widthPx, height: heightPx, channels },
    limitInputPixels: false,
  });

  if (dpi !== null) pipeline = pipeline.withMetadata({ density: dpi });

  switch (format) {
    case "png":
      pipeline = pipeline.png({ compressionLevel: fill === "solid" ? 9 : 6 });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: jpegQuality, chromaSubsampling: "4:4:4" });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality: 80 });
      break;
    case "gif":
      pipeline = pipeline.gif();
      break;
    case "tiff":
      pipeline = pipeline.tiff({ compression: "lzw" });
      break;
    default:
      throw new Error(`Unsupported format ${format}`);
  }

  await pipeline.toFile(outPath);
  record(outPath);
}

/**
 * Build a JFIF APP0 segment with an asymmetric X/Y density.
 *
 * sharp's `withMetadata({ density })` only writes a symmetric density (and
 * usually via EXIF, not JFIF), so to exercise the asymmetric branch we
 * prepend a hand-rolled JFIF APP0 segment right after the SOI marker.
 * JPEG readers (sharp, libvips, browsers) honour the first APP0 they find.
 */
function buildJfifApp0(xDpi, yDpi) {
  const seg = Buffer.alloc(2 + 16); // marker + length-prefixed payload
  seg[0] = 0xff;
  seg[1] = 0xe0;
  seg.writeUInt16BE(16, 2); // segment length, including these 2 bytes
  seg.write("JFIF\0", 4, "ascii");
  seg[9] = 1; // major version
  seg[10] = 2; // minor version (1.02)
  seg[11] = 1; // units = pixels per inch
  seg.writeUInt16BE(xDpi, 12);
  seg.writeUInt16BE(yDpi, 14);
  seg[16] = 0; // thumbnail width
  seg[17] = 0; // thumbnail height
  return seg;
}

async function makeAsymmetricDpiJpeg(outPath, widthPx, heightPx, xDpi, yDpi) {
  const raw = rgbGradient(widthPx, heightPx);
  const buf = await sharp(raw, {
    raw: { width: widthPx, height: heightPx, channels: 3 },
    limitInputPixels: false,
  })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("Not a JPEG");
  const out = Buffer.concat([
    buf.subarray(0, 2), // SOI
    buildJfifApp0(xDpi, yDpi),
    buf.subarray(2),
  ]);
  writeFileSync(outPath, out);
  record(outPath);
}

async function makePdf(outPath, pageCount, [pageWidthPt, pageHeightPt], label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([pageWidthPt, pageHeightPt]);
    p.drawText(`${label} - Page ${i + 1}/${pageCount}`, {
      x: 50,
      y: pageHeightPt - 60,
      size: 18,
      font,
    });
  }
  const bytes = await doc.save();
  writeFileSync(outPath, bytes);
  record(outPath);
}

console.log("Generating test fixtures...\n");

// =============================================================================
// A. DPI threshold fixtures (assume rule: dpi >= 300 blocking)
// =============================================================================
await makeImage({
  outPath: join(IMG, "A1_no_dpi_1200x1800.png"),
  widthPx: 1200,
  heightPx: 1800,
  format: "png",
  dpi: null,
});
await makeImage({
  outPath: join(IMG, "A2_72dpi_6x9.jpg"),
  widthPx: 432,
  heightPx: 648,
  format: "jpeg",
  dpi: 72,
});
await makeImage({
  outPath: join(IMG, "A3_150dpi_6x9.jpg"),
  widthPx: 900,
  heightPx: 1350,
  format: "jpeg",
  dpi: 150,
});
await makeImage({
  outPath: join(IMG, "A4_300dpi_6x9.jpg"),
  widthPx: 1800,
  heightPx: 2700,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "A5_600dpi_6x9.jpg"),
  widthPx: 3600,
  heightPx: 5400,
  format: "jpeg",
  dpi: 600,
});
await makeAsymmetricDpiJpeg(
  join(IMG, "A6_asym_200x300dpi.jpg"),
  1800,
  2700,
  200,
  300,
);

// =============================================================================
// B. Inch-dimension fixtures (target 4×6 exact, range 4–12)
// =============================================================================
await makeImage({
  outPath: join(IMG, "B1_300dpi_4x6.jpg"),
  widthPx: 1200,
  heightPx: 1800,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "B2_150dpi_4x6.jpg"),
  widthPx: 600,
  heightPx: 900,
  format: "jpeg",
  dpi: 150,
});
await makeImage({
  outPath: join(IMG, "B3_300dpi_4x6_plus1px.jpg"),
  widthPx: 1201,
  heightPx: 1801,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "B4_300dpi_5x7.5.jpg"),
  widthPx: 1500,
  heightPx: 2250,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "B5_300dpi_4x5.jpg"),
  widthPx: 1200,
  heightPx: 1500,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "B6_300dpi_just_under_4x6.jpg"),
  widthPx: 1199,
  heightPx: 1799,
  format: "jpeg",
  dpi: 300,
});
await makeImage({
  outPath: join(IMG, "B7_300dpi_just_over_8x12.jpg"),
  widthPx: 2401,
  heightPx: 3601,
  format: "jpeg",
  dpi: 300,
});

// =============================================================================
// C. Pixel-only rules (no DPI metadata)
// NOTE: JPEG cannot represent "no DPI" via sharp/libvips — it falls back to
// 72 DPI even when no JFIF density is written. Use PNG (no pHYs chunk) so
// `meta.density` is genuinely null and inch-based rules / pricing fail.
// =============================================================================
await makeImage({
  outPath: join(IMG, "C1_1199x1799_no_dpi.png"),
  widthPx: 1199,
  heightPx: 1799,
  format: "png",
  dpi: null,
});
await makeImage({
  outPath: join(IMG, "C2_1200x1800_no_dpi.png"),
  widthPx: 1200,
  heightPx: 1800,
  format: "png",
  dpi: null,
});
await makeImage({
  outPath: join(IMG, "C3_3000x4500_no_dpi.png"),
  widthPx: 3000,
  heightPx: 4500,
  format: "png",
  dpi: null,
});

// =============================================================================
// D. Decompression bomb / hard pixel cap (MAX_PIXELS = 100MP)
// =============================================================================
// Using 'solid' fill so PNG compresses these into < 1 MB despite the giant
// dimensions — that's the whole point of the bomb test.
await makeImage({
  outPath: join(IMG, "D1_9999_under_100MP.png"),
  widthPx: 9999,
  heightPx: 9999,
  format: "png",
  fill: "solid",
});
await makeImage({
  outPath: join(IMG, "D2_10001_over_100MP.png"),
  widthPx: 10001,
  heightPx: 10001,
  format: "png",
  fill: "solid",
});
await makeImage({
  outPath: join(IMG, "D3_12000_solid_compressed.png"),
  widthPx: 12000,
  heightPx: 12000,
  format: "png",
  fill: "solid",
});

// =============================================================================
// E. Plan size-tier fixtures (oversize/, gitignored)
// =============================================================================
// Using high-entropy noise so JPEG cannot compress past the size targets.
await makeImage({
  outPath: join(BIG, "E_free_51mb.jpg"),
  widthPx: 6000,
  heightPx: 4500,
  format: "jpeg",
  dpi: 300,
  fill: "noise",
  jpegQuality: 100,
});

const skipHeavy = process.argv.includes("--skip-heavy");
if (!skipHeavy) {
  await makeImage({
    outPath: join(BIG, "E_starter_101mb.jpg"),
    widthPx: 9000,
    heightPx: 6750,
    format: "jpeg",
    dpi: 300,
    fill: "noise",
    jpegQuality: 100,
  });
} else {
  console.log("  [skipped] E_starter_101mb.jpg (--skip-heavy)");
}

// =============================================================================
// F. MIME / format edge cases
// =============================================================================
await makeImage({
  outPath: join(IMG, "F1_valid.png"),
  widthPx: 800,
  heightPx: 600,
  format: "png",
});
await makeImage({
  outPath: join(IMG, "F2_valid.jpg"),
  widthPx: 800,
  heightPx: 600,
  format: "jpeg",
});
await makeImage({
  outPath: join(IMG, "F3_valid.webp"),
  widthPx: 800,
  heightPx: 600,
  format: "webp",
});
await makeImage({
  outPath: join(IMG, "F4_valid.gif"),
  widthPx: 800,
  heightPx: 600,
  format: "gif",
});
await makeImage({
  outPath: join(IMG, "F5_valid_300dpi.tiff"),
  widthPx: 800,
  heightPx: 600,
  format: "tiff",
  dpi: 300,
});

// F6: fake .png extension that actually contains JPEG bytes
const jpegBytes = await sharp(rgbGradient(400, 300), {
  raw: { width: 400, height: 300, channels: 3 },
})
  .jpeg({ quality: 85 })
  .toBuffer();
writeFileSync(join(IMG, "F6_fake_png_actually_jpeg.png"), jpegBytes);
record(join(IMG, "F6_fake_png_actually_jpeg.png"));

// F7: corrupt JPEG (truncated header)
writeFileSync(
  join(IMG, "F7_corrupt.jpg"),
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
);
record(join(IMG, "F7_corrupt.jpg"));

// F8: simple SVG
writeFileSync(
  join(IMG, "F8_simple.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
);
record(join(IMG, "F8_simple.svg"));

// =============================================================================
// G. PDF fixtures
// =============================================================================
await makePdf(join(PDF, "G1_letter_1page.pdf"), 1, [612, 792], "US Letter");
await makePdf(join(PDF, "G2_a4_1page.pdf"), 1, [595, 842], "A4");
await makePdf(join(PDF, "G3_a4_5pages.pdf"), 5, [595, 842], "A4");

// G4: encrypted PDF — pdf-lib does not encrypt, so we ship a placeholder note
const g4Note = join(PDF, "G4_encrypted_README.txt");
writeFileSync(
  g4Note,
  [
    "G4 (encrypted PDF) cannot be produced by pdf-lib.",
    "Generate manually with qpdf if available, e.g.:",
    "  qpdf --encrypt user owner 256 -- G2_a4_1page.pdf G4_encrypted.pdf",
    "Then re-run the upload flow — extractMetadata() opens it with",
    "{ ignoreEncryption: true } and should still report pageCount=1.",
  ].join("\n"),
);
record(g4Note);

// G5: corrupt PDF (truncated)
const validPdf = await (async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return doc.save();
})();
writeFileSync(
  join(PDF, "G5_corrupt.pdf"),
  Buffer.from(validPdf).subarray(0, Math.floor(validPdf.length / 2)),
);
record(join(PDF, "G5_corrupt.pdf"));

// =============================================================================
// Summary
// =============================================================================
console.log("\nGenerated fixtures:\n");
const fmt = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};
for (const { path, size } of generated) {
  console.log(`  ${fmt(size).padStart(10)}  ${path}`);
}

console.log(`\nTotal: ${generated.length} files.`);
console.log(`Repo-safe fixtures: ${IMG.replace(ROOT + "/", "")} and ${PDF.replace(ROOT + "/", "")}`);
console.log(`Oversize (gitignored): ${BIG.replace(ROOT + "/", "")}`);

if (existsSync(join(BIG, "E_starter_101mb.jpg"))) {
  const big = statSync(join(BIG, "E_starter_101mb.jpg")).size;
  if (big < 100 * 1024 * 1024) {
    console.warn(
      `\nWARNING: E_starter_101mb.jpg is only ${fmt(big)} — should exceed 100MB.`,
    );
  }
}
