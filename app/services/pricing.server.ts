import type { FileMetadata } from "./validation.server";

export type PricingMode = "inch_height" | "inch_square" | "flat" | null;

export interface PricingConfig {
  mode: PricingMode;
  unitPrice: number;
  minPrice: number;
  roundingEnabled?: boolean;
}

export interface PricingResult {
  filePrice: number;
  total: number;
  explanation: string;
  currency: string;
  /**
   * Machine-readable error code when pricing could not be computed (e.g. the file lacks the
   * dimensions the chosen pricing mode requires).
   */
  error?: "missing_dimensions" | "invalid_unit_price";
}

export function calculatePrice(
  metadata: FileMetadata,
  config: PricingConfig,
  quantity = 1,
  currency = "USD"
): PricingResult {
  const { mode, unitPrice, minPrice } = config;
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

  switch (mode) {
    case "inch_height":
      if (metadata.heightInch !== null && metadata.heightInch > 0) {
        const height = metadata.heightInch;
        rawPrice = height * unitPrice;
        explanation = `${height.toFixed(2)}" height × $${unitPrice}/inch`;
      } else {
        return {
          filePrice: 0,
          total: 0,
          explanation:
            "Price could not be calculated: file is missing measurable height in inches.",
          currency,
          error: "missing_dimensions",
        };
      }
      break;
    case "inch_square":
      {
        if (
          metadata.widthInch !== null &&
          metadata.widthInch > 0 &&
          metadata.heightInch !== null &&
          metadata.heightInch > 0
        ) {
          const width = metadata.widthInch;
          const height = metadata.heightInch;
          const area = width * height;
          rawPrice = area * unitPrice;
          explanation = `${width.toFixed(2)}" × ${height.toFixed(2)}" = ${area.toFixed(2)} in² × $${unitPrice}/in²`;
        } else {
          return {
            filePrice: 0,
            total: 0,
            explanation:
              "Price could not be calculated: file is missing measurable width and/or height in inches.",
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
