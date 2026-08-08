import { describe, expect, it } from "vitest";

import {
  normalizeShopPrimaryHost,
  shopStorefrontUrl,
} from "../app/services/shop-domain.utils";

describe("normalizeShopPrimaryHost", () => {
  it("accepts bare hosts and strips URL wrappers", () => {
    expect(normalizeShopPrimaryHost("PineappleApparels.com")).toBe("pineappleapparels.com");
    expect(normalizeShopPrimaryHost("https://pineappleapparels.com/")).toBe(
      "pineappleapparels.com",
    );
    expect(normalizeShopPrimaryHost("https://pineappleapparels.com:443/path")).toBe(
      "pineappleapparels.com",
    );
  });

  it("rejects unsafe or empty values", () => {
    expect(normalizeShopPrimaryHost("")).toBeNull();
    expect(normalizeShopPrimaryHost("javascript:alert(1)")).toBeNull();
    expect(normalizeShopPrimaryHost("a b.com")).toBeNull();
    expect(normalizeShopPrimaryHost("evil..com")).toBeNull();
  });
});

describe("shopStorefrontUrl", () => {
  it("prefers the primary domain when present", () => {
    expect(shopStorefrontUrl("pineappleapparels.com", "8cm1xx-0j.myshopify.com")).toBe(
      "https://pineappleapparels.com",
    );
  });

  it("falls back to the myshopify domain", () => {
    expect(shopStorefrontUrl(null, "alpha.myshopify.com")).toBe("https://alpha.myshopify.com");
  });
});
