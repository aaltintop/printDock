/**
 * Regression: extractMetadata must accept large-format print files.
 *
 * Shopper-facing limits are merchant maxFileMB (clamped by plan) and the
 * merchant's own dimension rules. There is no separate megapixel ceiling on
 * the metadata path — sharp is called with limitInputPixels: false because
 * metadata is header/attribute-only.
 */

import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractMetadata } from "../app/services/validation.server";

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const crc = u32(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([u32(data.length), typeBuf, data, crc]);
}

/**
 * Hand-written PNG whose IHDR declares huge dimensions. IDAT is a tiny valid
 * zlib stream that does not match the declared size — sharp.metadata() only
 * needs the header, so the fixture stays ~70 bytes.
 */
function hugeHeaderPng(widthPx: number, heightPx: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.concat([
    u32(widthPx),
    u32(heightPx),
    Buffer.from([8, 2, 0, 0, 0]), // 8-bit RGB
  ]);
  const idat = deflateSync(Buffer.from([0, 0, 0, 0]));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("extractMetadata large-format images", () => {
  it("accepts a PNG whose IHDR declares more than 100 megapixels", async () => {
    // 10001×10001 = 100.02 MP — previously rejected by MAX_PIXELS
    const buffer = hugeHeaderPng(10001, 10001);
    expect(buffer.length).toBeLessThan(200);

    const result = await extractMetadata(buffer, "image/png", buffer.length);

    expect(result.errorCode).toBeUndefined();
    expect(result.metadata.widthPx).toBe(10001);
    expect(result.metadata.heightPx).toBe(10001);
  });

  it("accepts a gigapixel-class header (Packly-scale large format)", async () => {
    // 50000×30000 = 1.5 GP — well above any former 100 MP / 1 GP cap
    const buffer = hugeHeaderPng(50000, 30000);

    const result = await extractMetadata(buffer, "image/png", buffer.length);

    expect(result.errorCode).toBeUndefined();
    expect(result.metadata.widthPx).toBe(50000);
    expect(result.metadata.heightPx).toBe(30000);
  });
});
