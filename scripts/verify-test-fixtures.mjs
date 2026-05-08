/**
 * Read every generated fixture with the same code paths used by
 * `app/services/validation.server.ts` (sharp / pdf-lib) and print the
 * extracted metadata so we can confirm each fixture exercises the intended
 * branch.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests/fixtures");

function listFiles(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
    .sort();
}

function fmtSize(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

async function inspectImage(filePath) {
  const buf = readFileSync(filePath);
  try {
    const meta = await sharp(buf, { limitInputPixels: false }).metadata();
    const dpi = meta.density ?? null;
    const widthPx = meta.width ?? null;
    const heightPx = meta.height ?? null;
    return {
      kind: meta.format,
      widthPx,
      heightPx,
      dpi,
      widthInch: dpi && widthPx ? +(widthPx / dpi).toFixed(2) : null,
      heightInch: dpi && heightPx ? +(heightPx / dpi).toFixed(2) : null,
    };
  } catch (err) {
    return { kind: "ERROR", error: err.message };
  }
}

async function inspectPdf(filePath) {
  const buf = readFileSync(filePath);
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = doc.getPages();
    const { width, height } = pages[0].getSize();
    return {
      kind: "pdf",
      pageCount: pages.length,
      widthInch: +(width / 72).toFixed(2),
      heightInch: +(height / 72).toFixed(2),
      dpi: 72,
    };
  } catch (err) {
    return { kind: "ERROR", error: err.message };
  }
}

const groups = [
  { dir: join(FIXTURES, "images"), label: "IMAGES" },
  { dir: join(FIXTURES, "pdfs"), label: "PDFS" },
  { dir: join(FIXTURES, "oversize"), label: "OVERSIZE" },
];

for (const { dir, label } of groups) {
  const files = listFiles(dir);
  if (!files.length) continue;
  console.log(`\n=== ${label} (${dir.replace(ROOT + "/", "")}) ===\n`);
  for (const f of files) {
    const size = statSync(f).size;
    const name = basename(f);
    const ext = name.split(".").pop().toLowerCase();
    let info;
    if (ext === "pdf") info = await inspectPdf(f);
    else if (["png", "jpg", "jpeg", "webp", "gif", "tiff", "svg"].includes(ext)) {
      info = await inspectImage(f);
    } else {
      info = { kind: ext };
    }
    const dims =
      info.widthPx != null
        ? `${info.widthPx}×${info.heightPx}px`
        : info.pageCount != null
          ? `${info.pageCount}p`
          : "—";
    const inches =
      info.widthInch != null
        ? `${info.widthInch}"×${info.heightInch}"`
        : "—";
    const dpi = info.dpi ?? "—";
    const err = info.error ? `  ⚠ ${info.error}` : "";
    console.log(
      `${name.padEnd(38)}  ${fmtSize(size).padStart(10)}  ${String(info.kind).padEnd(5)}  dims=${dims.padEnd(13)} dpi=${String(dpi).padEnd(5)} inch=${inches}${err}`,
    );
  }
}
