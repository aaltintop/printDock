import type { FileMetadata } from "./validation.server";

export type PricingMode = "inch_height" | "inch_square" | "flat" | null;

export interface PricingConfig {
  mode: PricingMode;
  unitPrice: number;
  minPrice: number;
  roundingEnabled?: boolean;
  printWidth?: number;
  /** Merchant-configured "assumed DPI" used to infer inches when the file itself has none. */
  assumedDpi?: number;
}

export interface PricingResult {
  filePrice: number;
  total: number;
  explanation: string;
  currency: string;
  /**
   * Machine-readable error code when pricing could not be computed (e.g. the file lacks the
   * dimensions the chosen pricing mode requires and no assumed DPI is configured).
   */
  error?: "missing_dimensions" | "invalid_unit_price";
}

export function calculatePrice(
  metadata: FileMetadata,
  config: PricingConfig,
  quantity = 1,
  currency = "USD"
): PricingResult {
  const { mode, unitPrice, minPrice, printWidth = 0, assumedDpi = 0 } = config;
  let rawPrice = 0;
  let explanation = "";

  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return {
      filePrice: 0,
      total: 0,
      explanation: "Invalid unit price configuration",
      currency,
      error: "invalid_unit_price",
    };
  }

  // Infer inches from pixel dimensions when the file has no embedded DPI but the merchant has
  // configured an "assumed DPI" on the field. Without this fallback, PNG/JPG files saved without
  // DPI metadata would silently price at $0 under inch_* modes.
  const inferredHeightInch =
    metadata.heightInch ??
    (metadata.heightPx && assumedDpi > 0
      ? metadata.heightPx / assumedDpi
      : null);
  const inferredWidthInch =
    metadata.widthInch ??
    (metadata.widthPx && assumedDpi > 0
      ? metadata.widthPx / assumedDpi
      : null);
  const dimensionsAreInferred =
    (inferredHeightInch !== null && metadata.heightInch === null) ||
    (inferredWidthInch !== null && metadata.widthInch === null);

  switch (mode) {
    case "inch_height":
      if (inferredHeightInch !== null && inferredHeightInch > 0) {
        const height = inferredHeightInch;
        rawPrice = height * unitPrice;
        explanation = `${height.toFixed(2)}" height × $${unitPrice}/inch`;
        if (dimensionsAreInferred) explanation += ` (using assumed ${assumedDpi} DPI)`;
      } else {
        return {
          filePrice: 0,
          total: 0,
          explanation:
            "Price could not be calculated: file is missing a height and no assumed DPI is configured.",
          currency,
          error: "missing_dimensions",
        };
      }
      break;
    case "inch_square":
      {
        const effectiveWidth = printWidth > 0 ? printWidth : inferredWidthInch;
        if (
          effectiveWidth !== null &&
          effectiveWidth > 0 &&
          inferredHeightInch !== null &&
          inferredHeightInch > 0
        ) {
          const width = effectiveWidth;
          const height = inferredHeightInch;
          const area = width * height;
          rawPrice = area * unitPrice;
          explanation = `${width.toFixed(2)}" × ${height.toFixed(2)}" = ${area.toFixed(2)} in² × $${unitPrice}/in²`;
          if (dimensionsAreInferred && printWidth <= 0) explanation += ` (using assumed ${assumedDpi} DPI)`;
        } else {
          return {
            filePrice: 0,
            total: 0,
            explanation:
              "Price could not be calculated: file is missing width/height and no assumed DPI or print width is configured.",
            currency,
            error: "missing_dimensions",
          };
        }
      }
      break;
    case "flat":
      rawPrice = unitPrice;
      explanation = `Flat rate: $${unitPrice}`;
      break;
    default:
      return { filePrice: 0, total: 0, explanation: "No pricing configured", currency };
  }

  // Apply minimum price floor
  const filePrice = Math.max(rawPrice, minPrice);
  if (filePrice > rawPrice && minPrice > 0) {
    explanation += explanation
      ? ` (minimum $${minPrice} applied)`
      : `Minimum $${minPrice} applied`;
  }

  const roundCurrency = (value: number) => Math.round(value * 100) / 100;
  const total = roundCurrency(filePrice * quantity);

  return {
    filePrice: roundCurrency(filePrice),
    total,
    explanation: quantity > 1 ? `${explanation} × ${quantity}` : explanation,
    currency,
  };
}
