import { describe, expect, it } from "vitest";
import {
  isPathProtectedFromOrphan,
  shouldSweepSession,
} from "../app/services/storage-retention-orphan.utils";
import type { UploadSession } from "../app/types/printdock";

function session(partial: Partial<UploadSession>): UploadSession {
  return {
    id: "s1",
    shopDomain: "shop.myshopify.com",
    productId: "p",
    variantId: "v",
    fieldId: null,
    status: "success",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    asset: null,
    assets: [{ id: "a1", storagePath: "uploads/shop.myshopify.com/s1/f.png" } as UploadSession["assets"][0]],
    ...partial,
  };
}

describe("shouldSweepSession", () => {
  it("does not sweep converted sessions", () => {
    expect(shouldSweepSession(session({ status: "converted" }), Date.now())).toBe(false);
  });

  it("does not sweep confirmed sessions before expiresAt", () => {
    expect(shouldSweepSession(session({ status: "success" }), Date.now())).toBe(false);
  });

  it("sweeps confirmed sessions after expiresAt", () => {
    expect(
      shouldSweepSession(
        session({
          status: "success",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        Date.now(),
      ),
    ).toBe(true);
  });
});

describe("isPathProtectedFromOrphan", () => {
  const shop = "shop.myshopify.com";

  it("protects order paths by prefix", () => {
    expect(
      isPathProtectedFromOrphan(`uploads/${shop}/orders/1/file.png`, shop, new Set()),
    ).toBe(true);
  });

  it("protects paths in the protected set", () => {
    expect(
      isPathProtectedFromOrphan(`uploads/${shop}/s1/f.png`, shop, new Set([`uploads/${shop}/s1/f.png`])),
    ).toBe(true);
  });
});
