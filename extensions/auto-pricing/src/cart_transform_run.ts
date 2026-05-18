import type { CartTransformRunInput } from "../generated/api";
import { Base64 } from "js-base64";

type CartTransformRunResult = {
  operations: Array<Record<string, unknown>>;
};

const NO_CHANGES: CartTransformRunResult = { operations: [] };

/** `cartTransformRun` uses `Operation.lineExpand` (schema); `FunctionRunResult` uses `CartOperation.expand`. */
const EXPAND_OPERATION_KEY =
  typeof process !== "undefined" && process.env?.PRINTDOCK_EXPAND_OP === "expand"
    ? "expand"
    : "lineExpand";

type InputLine = CartTransformRunInput["cart"]["lines"][number];

const DECIMALS: Record<string, number> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

function inferCurrencyDecimals(currencyCode: string): number {
  return DECIMALS[currencyCode.toUpperCase()] ?? 2;
}

function base64UrlToStd(segment: string): string {
  const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
  return segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
}

/** JWT payload is UTF-8 JSON; avoid `atob` + `TextDecoder` in Shopify Functions WASM. */
function base64UrlPayloadToUtf8(segment: string): string {
  return Base64.decode(base64UrlToStd(segment));
}

function base64UrlSignatureToBytes(segment: string): Uint8Array {
  return Base64.toUint8Array(base64UrlToStd(segment));
}

type TokenPayload = {
  shop: string;
  sid: string;
  p: number;
  c: string;
  exp: number;
  iat: number;
};

function parseJwtPayloadJson(payloadPart: string): TokenPayload | null {
  try {
    const json = base64UrlPayloadToUtf8(payloadPart);
    const body = JSON.parse(json) as Record<string, unknown>;
    const shop = String(body.shop || "");
    const sid = String(body.sid || "");
    const p = Number(body.p);
    const c = String(body.c || "").toUpperCase();
    const exp = Number(body.exp);
    const iat = Number(body.iat);
    if (!shop || !sid || !Number.isFinite(p) || p < 0 || !c || !Number.isFinite(exp) || !Number.isFinite(iat)) {
      return null;
    }
    return { shop, sid, p, c, exp, iat };
  } catch {
    return null;
  }
}

/**
 * Hand-rolled UTF-8 encoder — Javy may not expose TextEncoder, and library
 * implementations (crypto-js, @noble/hashes) all blew past the 11M-instruction
 * cap because of class hierarchies, BigInt fallbacks, and per-call assertions.
 */
function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        cp = 0x10000 + ((cp & 0x3ff) << 10) + (low & 0x3ff);
        i += 1;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** SHA-256 round constants. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Reusable message-schedule buffer (one allocation per call instead of per block). */
const W = new Uint32Array(64);

/**
 * One-shot SHA-256 of `msg`. Flat, inlined, no streaming buffer, no DataView,
 * no BigInt — every operation maps to a cheap Javy bytecode. Verified against
 * RFC test vectors via the unit tests + WASM fixture suite.
 *
 * NOTE: `msg.length` is treated as a 32-bit length (<= 2^29 bytes ≈ 512 MB),
 * which is dramatically larger than any cart transform input we will ever see.
 */
function sha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const bitLen = len * 8;
  const padLen = ((len + 9 + 63) & ~63) >>> 0;
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[len] = 0x80;
  padded[padLen - 4] = (bitLen >>> 24) & 0xff;
  padded[padLen - 3] = (bitLen >>> 16) & 0xff;
  padded[padLen - 2] = (bitLen >>> 8) & 0xff;
  padded[padLen - 1] = bitLen & 0xff;

  let h0 = 0x6a09e667 | 0;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372 | 0;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab | 0;
  let h7 = 0x5be0cd19 | 0;

  for (let block = 0; block < padLen; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = block + (i << 2);
      W[i] =
        ((padded[j]! << 24) |
          (padded[j + 1]! << 16) |
          (padded[j + 2]! << 8) |
          padded[j + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const v15 = W[i - 15]!;
      const v2 = W[i - 2]!;
      const s0 = ((v15 >>> 7) | (v15 << 25)) ^ ((v15 >>> 18) | (v15 << 14)) ^ (v15 >>> 3);
      const s1 = ((v2 >>> 17) | (v2 << 15)) ^ ((v2 >>> 19) | (v2 << 13)) ^ (v2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + W[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i += 1) {
    const v = hs[i]!;
    out[i * 4] = (v >>> 24) & 0xff;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

/** HMAC-SHA256(key, msg) per RFC 2104. Flat, no class hierarchy. */
function hmacSha256(keyBytes: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = keyBytes;
  if (k.length > 64) k = sha256(k);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    const kb = i < k.length ? k[i]! : 0;
    inner[i] = kb ^ 0x36;
    outer[i] = kb ^ 0x5c;
  }
  inner.set(msg, 64);
  const innerHash = sha256(inner);
  outer.set(innerHash, 64);
  return sha256(outer);
}

function hmacSha256Utf8(key: string, message: string): Uint8Array {
  return hmacSha256(utf8ToBytes(key), utf8ToBytes(message));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verifies the JWT's HMAC signature only.
 *
 * Expiration is *not* checked here: Shop.localTime in the Cart Transform input
 * exposes only boolean comparisons, not a raw datetime, so we cannot compare
 * against per-line `exp` values. The order/create webhook still re-verifies
 * `exp` server-side with a real clock — anything stale shows up there.
 *
 * Security argument: the price `p` is part of the signed payload. Without the
 * HMAC secret the attacker cannot mint a token with a different price.
 */
function verifyPriceToken(token: string, hmacKey: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  if (!headerPart || !payloadPart || !sigPart) return null;

  const signingInput = `${headerPart}.${payloadPart}`;
  const expected = hmacSha256Utf8(hmacKey, signingInput);
  let actual: Uint8Array;
  try {
    actual = base64UrlSignatureToBytes(sigPart);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, actual)) return null;

  return parseJwtPayloadJson(payloadPart);
}

function merchandiseVariantId(line: InputLine): string | null {
  const m = line.merchandise as unknown as Record<string, unknown>;
  if (m.__typename !== "ProductVariant") return null;
  const id = m.id;
  return typeof id === "string" ? id : null;
}

function hasSellingPlan(line: InputLine): boolean {
  return Boolean(line.sellingPlanAllocation?.sellingPlan?.id);
}

function formatMinorAsDecimal(amountMinor: number, currencyCode: string): string {
  const decimals = inferCurrencyDecimals(currencyCode);
  const scale = 10 ** decimals;
  return (Math.round(amountMinor) / scale).toFixed(decimals);
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const hmacKey = String(
    input.cartTransform.pricingHmac?.value ?? input.shop.shopHmac?.value ?? "",
  ).trim();
  if (!hmacKey) return NO_CHANGES;

  const lines = input.cart.lines;
  const operations: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    try {
      if (hasSellingPlan(line)) continue;
      const tokenRaw = String(line.priceToken?.value || "").trim();
      if (!tokenRaw) continue;

      const payload = verifyPriceToken(tokenRaw, hmacKey);
      if (!payload) continue;

      const variantId = merchandiseVariantId(line);
      if (!variantId) continue;

      const qty = Math.max(1, Math.floor(Number(line.quantity)));
      const amountStr = formatMinorAsDecimal(payload.p, payload.c);

      const expandPayload: Record<string, unknown> = {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: variantId,
            quantity: qty,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: amountStr,
                },
              },
            },
          },
        ],
      };

      operations.push({
        [EXPAND_OPERATION_KEY]: expandPayload,
      });
    } catch {
      continue;
    }
  }

  if (operations.length === 0) return NO_CHANGES;
  return { operations };
}
