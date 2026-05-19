import { describe, expect, it } from "vitest";
import { resolveSignedPriceTokenForSession } from "../app/services/price-token.server";

describe("resolveSignedPriceTokenForSession", () => {
  const sid = "session-abc";
  const lineToken = "eyJ.line.token";
  const mapToken = "eyJ.map.token";

  it("prefers line __ucToken over map", () => {
    const { token, mapLineMismatch } = resolveSignedPriceTokenForSession(
      sid,
      [{ name: "__ucToken", value: lineToken }],
      { [sid]: mapToken },
    );
    expect(token).toBe(lineToken);
    expect(mapLineMismatch).toBe(true);
  });

  it("falls back to map when line token missing", () => {
    const { token } = resolveSignedPriceTokenForSession(sid, [], { [sid]: mapToken });
    expect(token).toBe(mapToken);
  });

  it("returns undefined when both missing", () => {
    const { token } = resolveSignedPriceTokenForSession(sid, [], {});
    expect(token).toBeUndefined();
  });
});
