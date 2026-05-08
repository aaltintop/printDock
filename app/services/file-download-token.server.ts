import crypto from "node:crypto";

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

type TokenPayload = {
  shop: string;
  sp: string;
  fn: string;
  exp: number;
};

/** Canonical JSON for signing (sorted keys) so verify matches create. */
function canonicalTokenJson(payload: TokenPayload): string {
  return JSON.stringify({
    exp: payload.exp,
    fn: payload.fn,
    shop: payload.shop,
    sp: payload.sp,
  });
}

function signPayload(payloadStr: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");
}

export function createPrintReadyFileToken(
  shop: string,
  storagePath: string,
  originalName: string,
  secret: string,
): string | null {
  if (!secret) return null;
  if (!storagePath.startsWith(`uploads/${shop}/`)) return null;
  const payload: TokenPayload = {
    shop,
    sp: storagePath,
    fn: originalName,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadStr = canonicalTokenJson(payload);
  const sig = signPayload(payloadStr, secret);
  const payloadB64 = Buffer.from(payloadStr, "utf8").toString("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifyPrintReadyFileToken(
  token: string,
  secret: string,
): { shop: string; storagePath: string; originalName: string } | null {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload?.shop || !payload?.sp || !payload?.fn || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.sp.startsWith(`uploads/${payload.shop}/`)) return null;

  const payloadStr = canonicalTokenJson(payload);
  const expected = signPayload(payloadStr, secret);
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  return { shop: payload.shop, storagePath: payload.sp, originalName: payload.fn };
}
