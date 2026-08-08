import { describe, expect, it } from "vitest";
import {
  DIMENSION_DPI_LIMITS,
  DIMENSION_INCH_LIMITS,
  dimensionBoundError,
  getDimensionNumericLimits,
  inputToFiniteNumber,
} from "../app/utils/dimension-rule-limits";

describe("inputToFiniteNumber", () => {
  it("returns null for empty or whitespace (not 0)", () => {
    expect(inputToFiniteNumber("")).toBeNull();
    expect(inputToFiniteNumber("   ")).toBeNull();
    expect(inputToFiniteNumber("\t")).toBeNull();
  });

  it("parses plain numbers", () => {
    expect(inputToFiniteNumber("300")).toBe(300);
    expect(inputToFiniteNumber("0")).toBe(0);
    expect(inputToFiniteNumber("12.5")).toBe(12.5);
    expect(inputToFiniteNumber(" 42 ")).toBe(42);
  });

  it("accepts comma as decimal separator", () => {
    expect(inputToFiniteNumber("3,5")).toBe(3.5);
    expect(inputToFiniteNumber("0,01")).toBe(0.01);
  });

  it("rejects mixed comma and dot", () => {
    expect(inputToFiniteNumber("3,5.2")).toBeNull();
    expect(inputToFiniteNumber("1.234,56")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(inputToFiniteNumber("abc")).toBeNull();
    expect(inputToFiniteNumber("12px")).toBeNull();
  });
});

describe("getDimensionNumericLimits", () => {
  it("returns DPI limits for dpi", () => {
    expect(getDimensionNumericLimits("dpi")).toEqual(DIMENSION_DPI_LIMITS);
  });

  it("returns inch limits for width and height", () => {
    expect(getDimensionNumericLimits("widthInch")).toEqual(DIMENSION_INCH_LIMITS);
    expect(getDimensionNumericLimits("heightInch")).toEqual(DIMENSION_INCH_LIMITS);
  });
});

describe("dimensionBoundError", () => {
  it("rejects DPI above 2400", () => {
    expect(dimensionBoundError("DPI", 5000, DIMENSION_DPI_LIMITS)).toBe(
      "DPI must be between 1 and 2400.",
    );
  });

  it("rejects DPI below 1", () => {
    expect(dimensionBoundError("DPI", 0, DIMENSION_DPI_LIMITS)).toBe(
      "DPI must be between 1 and 2400.",
    );
  });

  it("accepts valid DPI", () => {
    expect(dimensionBoundError("DPI", 300, DIMENSION_DPI_LIMITS)).toBeNull();
    expect(dimensionBoundError("DPI", 1, DIMENSION_DPI_LIMITS)).toBeNull();
    expect(dimensionBoundError("DPI", 2400, DIMENSION_DPI_LIMITS)).toBeNull();
  });

  it("rejects inch below 0.01", () => {
    expect(dimensionBoundError("Width", 0, DIMENSION_INCH_LIMITS)).toBe(
      "Width must be between 0.01 and 500.",
    );
    expect(dimensionBoundError("Height", 0.001, DIMENSION_INCH_LIMITS)).toBe(
      "Height must be between 0.01 and 500.",
    );
  });

  it("rejects inch above 500", () => {
    expect(dimensionBoundError("Width", 501, DIMENSION_INCH_LIMITS)).toBe(
      "Width must be between 0.01 and 500.",
    );
  });

  it("accepts valid inch values", () => {
    expect(dimensionBoundError("Width", 0.01, DIMENSION_INCH_LIMITS)).toBeNull();
    expect(dimensionBoundError("Height", 24.5, DIMENSION_INCH_LIMITS)).toBeNull();
    expect(dimensionBoundError("Width", 500, DIMENSION_INCH_LIMITS)).toBeNull();
  });
});
