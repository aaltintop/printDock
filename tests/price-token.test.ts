import { describe, expect, it } from "vitest";
import {
  defaultTokenTtlSeconds,
  signPriceToken,
  verifyPriceToken,
  type PriceTokenPayload,
} from "../app/services/price-token.server";

const KEY = "fixture-hmac-key-32bytes-long!!";

function basePayload(over: Partial<PriceTokenPayload> = {}): PriceTokenPayload {
  const now = 1_700_000_000;
  return {
    shop: "test.myshopify.com",
    sid: "sess_1",
    p: 1299,
    c: "USD",
    exp: now + defaultTokenTtlSeconds(),
    iat: now,
    ...over,
  };
}

describe("price-token.server", () => {
  it("round-trips sign and verify", () => {
    const p = basePayload();
    const token = signPriceToken(p, KEY);
    const out = verifyPriceToken(token, KEY, p.iat + 60);
    expect(out).toEqual({ ...p, c: "USD" });
  });

  it("rejects tampered signature", () => {
    const token = signPriceToken(basePayload(), KEY);
    const broken = `${token.slice(0, -3)}xxx`;
    expect(verifyPriceToken(broken, KEY, basePayload().iat + 60)).toBeNull();
  });

  it("rejects expired token", () => {
    const now = 1_700_000_000;
    const token = signPriceToken(
      {
        shop: "test.myshopify.com",
        sid: "s",
        p: 100,
        c: "USD",
        exp: now + 10,
        iat: now,
      },
      KEY,
    );
    expect(verifyPriceToken(token, KEY, now + 3600)).toBeNull();
  });
});
