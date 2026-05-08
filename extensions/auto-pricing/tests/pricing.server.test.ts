import { describe, expect, it } from "vitest";
import { calculatePrice } from "../../../app/services/pricing.server";

const baseMetadata = {
  widthPx: null,
  heightPx: null,
  dpi: null,
  widthInch: null,
  heightInch: null,
  pageCount: null,
  fileSizeMB: 1,
};

describe("calculatePrice precision", () => {
  it("rounds only at final currency step for inch height mode", () => {
    const result = calculatePrice(
      {
        ...baseMetadata,
        heightInch: 10 / 3,
      },
      {
        mode: "inch_height",
        unitPrice: 3,
        minPrice: 0,
        roundingEnabled: true,
      },
      1,
    );

    expect(result.filePrice).toBe(10);
    expect(result.total).toBe(10);
  });

  it("uses full precision for file-provided inch dimensions", () => {
    const result = calculatePrice(
      {
        ...baseMetadata,
        widthInch: 3.333333,
        heightInch: 10,
      },
      {
        mode: "inch_square",
        unitPrice: 0.1,
        minPrice: 0,
      },
      1,
    );

    expect(result.filePrice).toBe(3.33);
    expect(result.total).toBe(3.33);
  });

  it("applies floor price to dynamic fee", () => {
    const result = calculatePrice(
      {
        ...baseMetadata,
        heightInch: 1,
      },
      {
        mode: "inch_height",
        unitPrice: 2,
        minPrice: 5,
      },
      1,
    );

    expect(result.filePrice).toBe(5);
    expect(result.total).toBe(5);
  });

  it("computes quantity total from precise fee before final rounding", () => {
    const result = calculatePrice(
      {
        ...baseMetadata,
        heightInch: 1,
      },
      {
        mode: "inch_height",
        unitPrice: 1 / 3,
        minPrice: 0,
      },
      3,
    );

    expect(result.filePrice).toBe(0.33);
    expect(result.total).toBe(1);
  });
});
