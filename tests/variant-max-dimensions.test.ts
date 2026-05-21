import { describe, expect, it } from "vitest";
import {
  VARIANT_MAX_DIMENSIONS_TOLERANCE,
  checkVariantMaxDimensions,
  formatVariantMaxDimensionsMessage,
} from "../app/utils/variant-max-dimensions";
import { lookupSavedVariantDimensions } from "../app/utils/field-target-product-variants";
import type { UploadFieldConfig } from "../app/types/printdock";

describe("checkVariantMaxDimensions", () => {
  it("passes when both limits set and file fits upright", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: 20,
        fileHeightInch: 14,
        maxWidthInch: 22,
        maxHeightInch: 16,
      }),
    ).toEqual({ status: "pass" });
  });

  it("passes when both limits set and file fits rotated", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: 16,
        fileHeightInch: 22,
        maxWidthInch: 22,
        maxHeightInch: 16,
      }),
    ).toEqual({ status: "pass" });
  });

  it("fails when both limits set and file exceeds both orientations", () => {
    const result = checkVariantMaxDimensions({
      fileWidthInch: 24,
      fileHeightInch: 20,
      maxWidthInch: 22,
      maxHeightInch: 16,
    });
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.ruleCode).toBe("variant_max_dimensions");
      expect(result.details).toEqual({
        fileWidthInch: 24,
        fileHeightInch: 20,
        maxWidthInch: 22,
        maxHeightInch: 16,
      });
    }
  });

  it("passes width-only limit when long edge is within tolerance", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: 18,
        fileHeightInch: 22,
        maxWidthInch: 22,
      }),
    ).toEqual({ status: "pass" });
  });

  it("fails width-only limit when long edge exceeds tolerance", () => {
    const result = checkVariantMaxDimensions({
      fileWidthInch: 18,
      fileHeightInch: 22.02,
      maxWidthInch: 22,
    });
    expect(result.status).toBe("fail");
  });

  it("passes height-only limit when long edge is within tolerance", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: 30,
        fileHeightInch: 16,
        maxHeightInch: 30,
      }),
    ).toEqual({ status: "pass" });
  });

  it("fails height-only limit when long edge exceeds tolerance", () => {
    const result = checkVariantMaxDimensions({
      fileWidthInch: 30.02,
      fileHeightInch: 16,
      maxHeightInch: 30,
    });
    expect(result.status).toBe("fail");
  });

  it("skips when file inch dimensions are missing", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: null,
        fileHeightInch: 10,
        maxWidthInch: 22,
        maxHeightInch: 16,
      }),
    ).toEqual({ status: "skip", reason: "missing_file_dimensions" });
  });

  it("skips when no variant limits are configured", () => {
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: 10,
        fileHeightInch: 8,
      }),
    ).toEqual({ status: "skip", reason: "no_variant_limits" });
  });

  it("passes at limit plus tolerance boundary", () => {
    const limit = 22;
    expect(
      checkVariantMaxDimensions({
        fileWidthInch: limit + VARIANT_MAX_DIMENSIONS_TOLERANCE,
        fileHeightInch: 10,
        maxWidthInch: limit,
        maxHeightInch: 16,
      }),
    ).toEqual({ status: "pass" });
  });

  it("fails just beyond limit plus tolerance", () => {
    const limit = 22;
    const result = checkVariantMaxDimensions({
      fileWidthInch: limit + VARIANT_MAX_DIMENSIONS_TOLERANCE + 0.001,
      fileHeightInch: 10,
      maxWidthInch: limit,
      maxHeightInch: 16,
    });
    expect(result.status).toBe("fail");
  });
});

describe("formatVariantMaxDimensionsMessage", () => {
  it("formats both limits to one decimal without rotation wording", () => {
    const message = formatVariantMaxDimensionsMessage(24.54, 18.01, 22, 16);
    expect(message).toBe(
      "This file is 24.5 × 18.0 in. The selected size allows up to 22.0 × 16.0 in.",
    );
    expect(message.toLowerCase()).not.toContain("rotat");
  });

  it("formats width-only limit", () => {
    expect(formatVariantMaxDimensionsMessage(24.5, 18, 22)).toBe(
      "This file is 24.5 × 18.0 in. The selected size allows up to 22.0 in.",
    );
  });

  it("formats height-only limit", () => {
    expect(formatVariantMaxDimensionsMessage(24.5, 18, undefined, 16)).toBe(
      "This file is 24.5 × 18.0 in. The selected size allows up to 16.0 in height.",
    );
  });
});

describe("lookupSavedVariantDimensions", () => {
  const field: UploadFieldConfig = {
    id: "field_1",
    adminTitle: "Poster",
    targetProducts: [
      {
        id: "123",
        title: "Poster",
        handle: "poster",
        variants: [{ variantId: "456", width: 22, height: 16 }],
      },
    ],
    targetProductIds: ["123"],
    targetCollections: [],
    targetCollectionIds: [],
    targetVariantIds: [],
    isActive: true,
    storefrontTitle: "",
    storefrontDescription: "",
    isRequired: false,
    minFiles: 1,
    maxFiles: 1,
    maxFileMB: 50,
    allowedExtensions: ["pdf"],
    dimensionRules: [],
    dimensionRulesSimplified: false,
    pricing: { enabled: false, unitType: "flat", unitPrice: 0, minPrice: 0, roundingEnabled: false },
    fileRenamePattern: "",
    planRequirement: "free",
    createdAt: "",
    updatedAt: "",
  };

  it("finds limits by numeric product and variant ids", () => {
    expect(lookupSavedVariantDimensions(field, "123", "456")).toEqual({
      maxWidthInch: 22,
      maxHeightInch: 16,
    });
  });

  it("matches gid-style ids", () => {
    expect(
      lookupSavedVariantDimensions(
        field,
        "gid://shopify/Product/123",
        "gid://shopify/ProductVariant/456",
      ),
    ).toEqual({ maxWidthInch: 22, maxHeightInch: 16 });
  });

  it("returns null when variant has no saved dimensions", () => {
    const emptyField: UploadFieldConfig = {
      ...field,
      targetProducts: [{ id: "123", title: "Poster", handle: "poster", variants: [{ variantId: "456" }] }],
    };
    expect(lookupSavedVariantDimensions(emptyField, "123", "456")).toBeNull();
  });
});
