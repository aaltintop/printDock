/**
 * Authoritative DPI extraction for PNG and JPEG.
 *
 * Why this exists: sharp/libvips returns a fabricated DPI when the file
 * carries no density metadata at all — ~25 DPI for PNG (libvips' default
 * `Xres = 1.0 ppm`) and 72 DPI for JPEG (libvips' fallback). That means a
 * "no DPI metadata" file silently passes through pricing/validation with
 * the wrong measurements, e.g. a 1200×1800 PNG without `pHYs` would show
 * up as 48 × 72 inches when it actually has no defined physical size.
 *
 * For PNG and JPEG we parse the bytes ourselves so we can tell the
 * difference between "really has 25 DPI embedded" and "has no DPI at
 * all". For other image formats (WebP, TIFF, GIF) we still rely on
 * sharp, with a low-DPI heuristic floor applied downstream.
 *
 * Return value semantics:
 *   • number  — the file definitely carries that DPI (X-axis).
 *   • null    — the file does NOT advertise a usable DPI. Callers must
 *               treat `widthInch` / `heightInch` as unknown.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PHYS_UNIT_METER = 1;
const PIXELS_PER_METER_TO_DPI = 0.0254; // 1 inch = 0.0254 m

/**
 * Read X-axis DPI from a PNG `pHYs` chunk. Returns null when the file
 * has no `pHYs` chunk, when the chunk uses `unit = 0` (aspect-ratio
 * only, no physical meaning), or when the file is not a valid PNG.
 *
 * PNG layout:
 *   8-byte signature, then a sequence of chunks:
 *     [4 bytes length][4 bytes type][length bytes data][4 bytes CRC]
 *   `pHYs` chunk data is 9 bytes:
 *     [4 bytes X pixels-per-unit][4 bytes Y pixels-per-unit][1 byte unit]
 *   Unit: 0 = unknown (ratio only), 1 = meter.
 */
export function readPngDpi(buf: Buffer): number | null {
  if (buf.length < PNG_SIGNATURE.length + 12) return null;
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32BE(offset);
    const chunkType = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd + 4 > buf.length) return null;

    if (chunkType === "pHYs") {
      if (chunkLength !== 9) return null;
      const xPpu = buf.readUInt32BE(dataStart);
      const unit = buf.readUInt8(dataStart + 8);
      if (unit !== PHYS_UNIT_METER || xPpu === 0) return null;
      const dpi = xPpu * PIXELS_PER_METER_TO_DPI;
      if (!Number.isFinite(dpi) || dpi <= 0) return null;
      return Math.round(dpi);
    }

    // `pHYs` must appear before `IDAT`/`IEND` per the PNG spec — once we
    // see image data, there's no point walking further.
    if (chunkType === "IDAT" || chunkType === "IEND") return null;

    offset = dataEnd + 4; // skip data + CRC
  }
  return null;
}

/**
 * Read X-axis DPI from a JPEG JFIF APP0 segment. Returns null when no
 * JFIF identifier is present, the units field marks the densities as
 * aspect-ratio only, or the file is not a recognizable JPEG.
 *
 * Scope (per project decision): only the JFIF APP0 segment is consulted.
 * EXIF (APP1) is NOT parsed — files written by Photoshop / Lightroom
 * that embed density only in EXIF will be treated as "no DPI" by this
 * function and surface the explicit "missing DPI" message to the
 * shopper. Document the supported formats in the admin so merchants
 * know what to expect.
 *
 * JFIF APP0 layout (right after SOI, sometimes after other APPn):
 *   [0xFF][0xE0][2-byte length][JFIF\0][2 bytes version]
 *   [1 byte units][2 bytes Xdensity][2 bytes Ydensity]
 *   [1 byte thumb W][1 byte thumb H][thumb data]
 *   Units: 0 = no units (ratio only), 1 = DPI, 2 = dots per cm.
 */
export function readJfifDpi(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI

  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xd9) return null; // EOI
    if (marker === 0xda) return null; // SOS — no JFIF after entropy data
    if (marker === 0x00 || marker === 0xff) {
      // fill bytes; continue scanning
      offset += 1;
      continue;
    }

    const segLength = buf.readUInt16BE(offset + 2);
    if (segLength < 2 || offset + 2 + segLength > buf.length) return null;

    if (marker === 0xe0 && segLength >= 16) {
      const identifier = buf.subarray(offset + 4, offset + 9).toString("ascii");
      if (identifier === "JFIF\u0000") {
        const units = buf.readUInt8(offset + 11);
        const xDensity = buf.readUInt16BE(offset + 12);
        if (units === 0 || xDensity === 0) return null;
        if (units === 1) return xDensity; // already DPI
        if (units === 2) return Math.round(xDensity * 2.54); // dots/cm → DPI
        return null;
      }
    }

    offset += 2 + segLength;
  }
  return null;
}

/**
 * Convenience dispatch: looks at the actual MIME type and returns the
 * authoritative DPI (or null). Falls back to undefined when the format
 * is not one we authoritatively parse — callers should then trust
 * sharp's value (subject to the heuristic floor).
 */
export function readAuthoritativeDpi(
  buf: Buffer,
  mimeType: string,
): { supported: boolean; dpi: number | null } {
  if (mimeType === "image/png") {
    return { supported: true, dpi: readPngDpi(buf) };
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return { supported: true, dpi: readJfifDpi(buf) };
  }
  return { supported: false, dpi: null };
}

/**
 * Image formats where we authoritatively determine DPI by parsing the
 * file bytes ourselves. For everything else we rely on sharp's reading
 * (subject to a low-DPI heuristic). Surfaced in the admin so merchants
 * understand which formats give the most predictable DPI behavior.
 */
export const DPI_AUTHORITATIVE_FORMATS = ["PNG", "JPEG"] as const;

/**
 * Heuristic floor for DPI values that come from sharp (i.e. formats we
 * don't parse authoritatively). libvips falls back to plausible-looking
 * defaults when no density is embedded — anything under this threshold
 * is almost certainly a fallback, not a real measurement. Tuned to be
 * conservative: legitimate banner / large-format prints can legitimately
 * be 50–100 DPI, but virtually nothing is under 30 in practice.
 */
export const DPI_HEURISTIC_FLOOR = 30;
