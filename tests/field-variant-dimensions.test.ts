import { describe, expect, it } from "vitest";
import {
  applyVariantInputsToProducts,
  mergeVariantDimensionIntoProducts,
  normalizeTargetProductsForSave,
} from "../app/utils/field-target-product-variants";

describe("normalizeTargetProductsForSave", () => {
  it("persists both width and height", () => {
    const saved = normalizeTargetProductsForSave([
      {
        id: "1",
        title: "Poster",
        handle: "poster",
        variants: [{ variantId: "10", width: 22, height: 24 }],
      },
    ]);

    expect(saved[0]?.variants).toEqual([{ variantId: "10", width: 22, height: 24 }]);
  });

  it("persists only width when height is absent", () => {
    const saved = normalizeTargetProductsForSave([
      {
        id: "1",
        title: "Poster",
        handle: "poster",
        variants: [{ variantId: "10", width: 22 }],
      },
    ]);

    expect(saved[0]?.variants).toEqual([{ variantId: "10", width: 22 }]);
    expect(saved[0]?.variants?.[0]).not.toHaveProperty("height");
  });

  it("omits variants when neither width nor height is set", () => {
    const saved = normalizeTargetProductsForSave([
      {
        id: "1",
        title: "Poster",
        handle: "poster",
        variants: [{ variantId: "10" }],
      },
    ]);

    expect(saved[0]?.variants).toBeUndefined();
  });

  it("strips invalid dimension values", () => {
    const saved = normalizeTargetProductsForSave([
      {
        id: "1",
        title: "Poster",
        handle: "poster",
        variants: [{ variantId: "10", width: -1, height: "abc" }],
      },
    ]);

    expect(saved[0]?.variants).toBeUndefined();
  });
});

describe("applyVariantInputsToProducts", () => {
  const products = [{ id: "1", title: "Poster", handle: "poster" }];
  const knownVariantIds = new Map<string, string[]>([["1", ["10"]]]);

  it("round-trips width and height into targetProducts", () => {
    const result = applyVariantInputsToProducts(
      products,
      { "10": { width: "22", height: "24" } },
      knownVariantIds,
    );

    expect(result[0]?.variants).toEqual([{ variantId: "10", width: 22, height: 24 }]);
  });

  it("omits empty variant entries", () => {
    const result = applyVariantInputsToProducts(
      products,
      { "10": { width: "", height: "" } },
      knownVariantIds,
    );

    expect(result[0]?.variants).toBeUndefined();
  });
});

describe("mergeVariantDimensionIntoProducts", () => {
  const products = [
    {
      id: "1",
      title: "Poster",
      handle: "poster",
      variants: [{ variantId: "10", width: 22, height: 24 }],
    },
  ];

  it("updates an existing variant entry", () => {
    const { products: next, variant } = mergeVariantDimensionIntoProducts(
      products,
      "1",
      "10",
      30,
      36,
    );

    expect(variant).toEqual({ variantId: "10", width: 30, height: 36 });
    expect(next[0]?.variants).toEqual([{ variantId: "10", width: 30, height: 36 }]);
  });

  it("adds a new variant entry to a product", () => {
    const { products: next, variant } = mergeVariantDimensionIntoProducts(
      [{ id: "1", title: "Poster", handle: "poster" }],
      "1",
      "11",
      22,
      24,
    );

    expect(variant).toEqual({ variantId: "11", width: 22, height: 24 });
    expect(next[0]?.variants).toEqual([{ variantId: "11", width: 22, height: 24 }]);
  });

  it("removes a variant entry when both dimensions are cleared", () => {
    const { products: next, variant } = mergeVariantDimensionIntoProducts(
      products,
      "1",
      "10",
      undefined,
      undefined,
    );

    expect(variant).toBeNull();
    expect(next[0]?.variants).toBeUndefined();
  });
});
