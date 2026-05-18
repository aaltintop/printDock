import { createHmac, timingSafeEqual } from "crypto";

/**
 * Compact signed token for dynamic cart line pricing (Cart Transform `expand`).
 * Format: base64url(header).base64url(payload).base64url(signature)
 * where signature = HMAC-SHA256(header.payload, hmacKey) over UTF-8 bytes of the signing input string.
 */

export type PriceTokenPayload = {
  /** Shop domain (prevents naive cross-shop replay in order webhook) */
  shop: string;
  /** Upload session id (= _uc_session) */
  sid: string;
  /** Unit price in minor units (integer), shop currency */
  p: number;
  /** ISO 4217 currency code */
  c: string;
  /** Unix seconds — token not valid after this */
  exp: number;
  /** Unix seconds — issued at */
  iat: number;
};

const HEADER = { alg: "HS256", typ: "JWT" } as const;

function utf8Bytes(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export function signPriceToken(payload: PriceTokenPayload, hmacKey: string): string {
  const headerPart = toBase64Url(utf8Bytes(JSON.stringify(HEADER)));
  const payloadPart = toBase64Url(
    utf8Bytes(
      JSON.stringify({
        shop: payload.shop,
        sid: payload.sid,
        p: payload.p,
        c: payload.c,
        exp: payload.exp,
        iat: payload.iat,
      }),
    ),
  );
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = createHmac("sha256", utf8Bytes(hmacKey)).update(signingInput, "utf8").digest();
  return `${signingInput}.${toBase64Url(sig)}`;
}

export function verifyPriceToken(
  token: string,
  hmacKey: string,
  nowUnixSeconds: number,
): PriceTokenPayload | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expected = createHmac("sha256", utf8Bytes(hmacKey)).update(signingInput, "utf8").digest();
  let actual: Buffer;
  try {
    actual = fromBase64Url(sigPart);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(fromBase64Url(payloadPart).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const shop = String(body.shop || "");
  const sid = String(body.sid || "");
  const p = Number(body.p);
  const c = String(body.c || "").toUpperCase();
  const exp = Number(body.exp);
  const iat = Number(body.iat);
  if (!shop || !sid || !Number.isFinite(p) || p < 0 || !c || !Number.isFinite(exp) || !Number.isFinite(iat)) {
    return null;
  }
  if (nowUnixSeconds > exp) return null;

  return { shop, sid, p, c, exp, iat };
}

export function defaultTokenTtlSeconds(): number {
  return 24 * 60 * 60;
}
