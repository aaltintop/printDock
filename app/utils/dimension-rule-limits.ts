export type SupportedDimensionType = "widthInch" | "heightInch" | "dpi";

export const DIMENSION_INCH_LIMITS = { min: 0.01, max: 500, step: 0.01 } as const;
export const DIMENSION_DPI_LIMITS = { min: 1, max: 2400, step: 1 } as const;

export function getDimensionNumericLimits(
  dimensionType: SupportedDimensionType,
): { min: number; max: number; step: number } {
  if (dimensionType === "dpi") return DIMENSION_DPI_LIMITS;
  return DIMENSION_INCH_LIMITS;
}

/**
 * Parse a merchant-entered dimension value.
 * Empty / whitespace → null (not 0 — Number("") is 0, which was a save bug).
 * Accepts either comma or dot as the decimal separator, but not both.
 */
export function inputToFiniteNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(",") && trimmed.includes(".")) return null;
  const normalized = trimmed.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dimensionBoundError(
  label: string,
  value: number,
  limits: { min: number; max: number },
): string | null {
  if (value < limits.min || value > limits.max) {
    return `${label} must be between ${limits.min} and ${limits.max}.`;
  }
  return null;
}
