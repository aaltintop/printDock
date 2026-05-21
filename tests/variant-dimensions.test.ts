import { describe, expect, it } from "vitest";
import { parseVariantDimensions } from "../app/utils/variant-dimensions";

describe("parseVariantDimensions", () => {
  it.each([
    ["22*24", { width: 22, height: 24 }],
    ["22x24", { width: 22, height: 24 }],
    ["22X24", { width: 22, height: 24 }],
    ["22×24", { width: 22, height: 24 }],
    ["22 x 24", { width: 22, height: 24 }],
    ["22.5x24", { width: 22.5, height: 24 }],
    ["Large (22×24)", { width: 22, height: 24 }],
    ["Black / 22x24", { width: 22, height: 24 }],
    ["22×24 / Red", { width: 22, height: 24 }],
  ])("parses %s", (title, expected) => {
    expect(parseVariantDimensions(title)).toEqual(expected);
  });

  it.each([
    "",
    "T-shirt",
    "Width 22 Height 24",
    "22 inches",
    "xyz",
    "0x24",
    "-22x24",
  ])("returns null for %s", (title) => {
    expect(parseVariantDimensions(title)).toBeNull();
  });
});
