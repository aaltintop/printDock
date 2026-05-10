/**
 * Tests for the authoritative DPI binary parsers.
 *
 * sharp/libvips fabricates fallback densities (≈25 DPI for PNG, 72 DPI
 * for JPEG) when a file embeds no density metadata, which silently
 * breaks inch-based validation and pricing. These tests verify that we
 * read the file ourselves and correctly distinguish "really has DPI X"
 * from "no DPI advertised".
 */

import { describe, expect, it } from "vitest";
import { readPngDpi, readJfifDpi, readAuthoritativeDpi } from "../app/services/image-dpi.server";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  // CRC is irrelevant for the parser (we never verify it), but include
  // 4 bytes so chunk-walking math matches a real PNG.
  const crc = Buffer.alloc(4);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function physChunk(xPpm: number, yPpm: number, unit = 1): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt32BE(xPpm, 0);
  data.writeUInt32BE(yPpm, 4);
  data.writeUInt8(unit, 8);
  return chunk("pHYs", data);
}

function buildPng({ phys, ihdr = true }: { phys?: Buffer; ihdr?: boolean } = {}): Buffer {
  const parts: Buffer[] = [PNG_SIG];
  if (ihdr) parts.push(chunk("IHDR", Buffer.alloc(13)));
  if (phys) parts.push(phys);
  parts.push(chunk("IDAT", Buffer.alloc(1)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe("readPngDpi", () => {
  it("returns null when the buffer is not a PNG", () => {
    expect(readPngDpi(Buffer.from("not a png"))).toBeNull();
    expect(readPngDpi(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when no pHYs chunk is present (the libvips '25 DPI' bug we are fixing)", () => {
    const png = buildPng();
    expect(readPngDpi(png)).toBeNull();
  });

  it("returns the DPI when pHYs unit=1 (meters)", () => {
    // 300 DPI ≈ 11811 ppm. Allow rounding tolerance.
    const png = buildPng({ phys: physChunk(11811, 11811, 1) });
    expect(readPngDpi(png)).toBe(300);
  });

  it("returns 72 DPI for a typical screen-density pHYs", () => {
    // 72 DPI = 2835 ppm
    const png = buildPng({ phys: physChunk(2835, 2835, 1) });
    expect(readPngDpi(png)).toBe(72);
  });

  it("returns null when pHYs unit=0 (aspect ratio only)", () => {
    const png = buildPng({ phys: physChunk(11811, 11811, 0) });
    expect(readPngDpi(png)).toBeNull();
  });

  it("returns null when xPpu is zero", () => {
    const png = buildPng({ phys: physChunk(0, 11811, 1) });
    expect(readPngDpi(png)).toBeNull();
  });

  it("stops walking once IDAT is reached (pHYs must come first per spec)", () => {
    const parts: Buffer[] = [
      PNG_SIG,
      chunk("IHDR", Buffer.alloc(13)),
      chunk("IDAT", Buffer.alloc(4)),
      physChunk(11811, 11811, 1), // intentionally placed after IDAT — must be ignored
      chunk("IEND", Buffer.alloc(0)),
    ];
    expect(readPngDpi(Buffer.concat(parts))).toBeNull();
  });
});

function buildJfif({
  units,
  xDensity,
  yDensity = xDensity,
  withSoi = true,
}: {
  units: number;
  xDensity: number;
  yDensity?: number;
  withSoi?: boolean;
}): Buffer {
  const app0 = Buffer.alloc(2 + 16);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2); // segment length includes the length bytes
  app0.write("JFIF\0", 4, "ascii");
  app0[9] = 1; // version major
  app0[10] = 2; // version minor
  app0[11] = units;
  app0.writeUInt16BE(xDensity, 12);
  app0.writeUInt16BE(yDensity, 14);
  app0[16] = 0; // thumb width
  app0[17] = 0; // thumb height
  // SOS marker so the parser knows to stop walking after the APP0 (real
  // entropy-coded data is irrelevant for these tests).
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
  return Buffer.concat([withSoi ? Buffer.from([0xff, 0xd8]) : Buffer.alloc(0), app0, sos]);
}

describe("readJfifDpi", () => {
  it("returns null when the buffer is not a JPEG", () => {
    expect(readJfifDpi(Buffer.from("not a jpeg"))).toBeNull();
    expect(readJfifDpi(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when JPEG has SOI but no JFIF APP0 (the libvips '72 DPI' bug we are fixing)", () => {
    // SOI + arbitrary non-APP0 segment + SOS
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x00, 0x00]), // COM segment
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
    ]);
    expect(readJfifDpi(buf)).toBeNull();
  });

  it("returns the DPI when JFIF units=1 (DPI direct)", () => {
    expect(readJfifDpi(buildJfif({ units: 1, xDensity: 300 }))).toBe(300);
    expect(readJfifDpi(buildJfif({ units: 1, xDensity: 72 }))).toBe(72);
  });

  it("converts DPCM → DPI when JFIF units=2", () => {
    // 118 dots/cm ≈ 300 DPI
    expect(readJfifDpi(buildJfif({ units: 2, xDensity: 118 }))).toBe(Math.round(118 * 2.54));
  });

  it("returns null when JFIF units=0 (aspect ratio only)", () => {
    expect(readJfifDpi(buildJfif({ units: 0, xDensity: 1 }))).toBeNull();
  });

  it("returns null when xDensity is zero", () => {
    expect(readJfifDpi(buildJfif({ units: 1, xDensity: 0 }))).toBeNull();
  });

  it("handles JFIF segments that are not the first APPn", () => {
    // SOI + APP1 (EXIF-ish stub) + APP0 (JFIF) + SOS
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1]),
      (() => {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16BE(10, 0);
        return lenBuf;
      })(),
      Buffer.alloc(8), // arbitrary EXIF stub
    ]);
    const jfifAlone = buildJfif({ units: 1, xDensity: 240, withSoi: false });
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, jfifAlone]);
    expect(readJfifDpi(buf)).toBe(240);
  });
});

describe("readAuthoritativeDpi", () => {
  it("dispatches PNG MIME to the PNG reader", () => {
    const png = buildPng({ phys: physChunk(11811, 11811, 1) });
    expect(readAuthoritativeDpi(png, "image/png")).toEqual({ supported: true, dpi: 300 });
  });

  it("dispatches JPEG MIME to the JFIF reader", () => {
    const jpeg = buildJfif({ units: 1, xDensity: 150 });
    expect(readAuthoritativeDpi(jpeg, "image/jpeg")).toEqual({ supported: true, dpi: 150 });
    expect(readAuthoritativeDpi(jpeg, "image/jpg")).toEqual({ supported: true, dpi: 150 });
  });

  it("marks PNG without pHYs as supported=true, dpi=null (NOT 25)", () => {
    // This is the exact scenario from the user's bug report: a PNG with
    // no pHYs chunk must return null so the shopper sees a "missing DPI"
    // message instead of a fabricated 25 DPI / 48 inch reading.
    expect(readAuthoritativeDpi(buildPng(), "image/png")).toEqual({
      supported: true,
      dpi: null,
    });
  });

  it("returns supported=false for non PNG/JPEG formats", () => {
    expect(readAuthoritativeDpi(Buffer.alloc(16), "image/webp")).toEqual({
      supported: false,
      dpi: null,
    });
    expect(readAuthoritativeDpi(Buffer.alloc(16), "image/tiff")).toEqual({
      supported: false,
      dpi: null,
    });
  });
});
