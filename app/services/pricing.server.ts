import type { FileMetadata } from "./validation.server";

export type PricingMode = "inch_height" | "inch_square" | "per_file" | "flat" | null;

export interface PricingConfig {
  mode: PricingMode;
  unitPrice: number;
  minPrice: number;
  roundingEnabled?: boolean;
  printWidth?: number;
}

export interface PricingResult {
  filePrice: number;
  total: number;
  explanation: string;
  currency: string;
}

export function calculatePrice(
  metadata: FileMetadata,
  config: PricingConfig,
  quantity = 1,
  currency = "USD"
): PricingResult {
  const { mode, unitPrice, minPrice, roundingEnabled = false, printWidth = 0 } = config;
  let rawPrice = 0;
  let explanation = "";

  const roundDimension = (value: number) => (roundingEnabled ? Math.ceil(value) : value);

  switch (mode) {
    case "inch_height":
      if (metadata.heightInch) {
        const height = roundDimension(metadata.heightInch);
        rawPrice = height * unitPrice;
        explanation = `${height.toFixed(2)}" height × $${unitPrice}/inch`;
        if (roundingEnabled) {
          explanation += " (rounded up)";
        }
      }
      break;
    case "inch_square":
      if ((metadata.widthInch || printWidth > 0) && metadata.heightInch) {
        const width = roundDimension(printWidth > 0 ? printWidth : (metadata.widthInch as number));
        const height = roundDimension(metadata.heightInch);
        const area = width * height;
        rawPrice = area * unitPrice;
        explanation = `${width.toFixed(2)}" × ${height.toFixed(2)}" = ${area.toFixed(2)} in² × $${unitPrice}/in²`;
        if (roundingEnabled) {
          explanation += " (rounded up)";
        }
      }
      break;
    case "per_file":
      rawPrice = unitPrice;
      explanation = `$${unitPrice} per file`;
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
  if (rawPrice < minPrice && rawPrice > 0) {
    explanation += ` (minimum $${minPrice} applied)`;
  }

  const total = Math.round(filePrice * quantity * 100) / 100;

  return {
    filePrice: Math.round(filePrice * 100) / 100,
    total,
    explanation: quantity > 1 ? `${explanation} × ${quantity}` : explanation,
    currency,
  };
}
