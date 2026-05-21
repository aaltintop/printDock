export const VARIANT_MAX_DIMENSIONS_TOLERANCE = 0.01;
export const VARIANT_MAX_DIMENSIONS_RULE_CODE = "variant_max_dimensions";

export type VariantMaxDimensionsInput = {
  fileWidthInch: number | null;
  fileHeightInch: number | null;
  maxWidthInch?: number;
  maxHeightInch?: number;
};

export type VariantMaxDimensionsSkipReason =
  | "no_variant_limits"
  | "missing_file_dimensions";

export type VariantMaxDimensionsOutcome =
  | { status: "pass" }
  | { status: "skip"; reason: VariantMaxDimensionsSkipReason }
  | {
      status: "fail";
      ruleCode: typeof VARIANT_MAX_DIMENSIONS_RULE_CODE;
      message: string;
      details: {
        fileWidthInch: number;
        fileHeightInch: number;
        maxWidthInch?: number;
        maxHeightInch?: number;
      };
    };

function formatInchDisplay(value: number): string {
  return value.toFixed(1);
}

export function formatVariantMaxDimensionsMessage(
  fileW: number,
  fileH: number,
  maxW?: number,
  maxH?: number,
): string {
  const filePart = `${formatInchDisplay(fileW)} × ${formatInchDisplay(fileH)} in.`;
  if (maxW != null && maxH != null) {
    return `This file is ${filePart} The selected size allows up to ${formatInchDisplay(maxW)} × ${formatInchDisplay(maxH)} in.`;
  }
  if (maxW != null) {
    return `This file is ${filePart} The selected size allows up to ${formatInchDisplay(maxW)} in.`;
  }
  if (maxH != null) {
    return `This file is ${filePart} The selected size allows up to ${formatInchDisplay(maxH)} in height.`;
  }
  return `This file is ${filePart}`;
}

function withinTolerance(actual: number, limit: number): boolean {
  return actual <= limit + VARIANT_MAX_DIMENSIONS_TOLERANCE;
}

function fitsBothLimits(
  fileW: number,
  fileH: number,
  maxW: number,
  maxH: number,
): boolean {
  return (
    (withinTolerance(fileW, maxW) && withinTolerance(fileH, maxH)) ||
    (withinTolerance(fileW, maxH) && withinTolerance(fileH, maxW))
  );
}

export function checkVariantMaxDimensions(
  input: VariantMaxDimensionsInput,
): VariantMaxDimensionsOutcome {
  const { fileWidthInch, fileHeightInch, maxWidthInch, maxHeightInch } = input;

  if (maxWidthInch == null && maxHeightInch == null) {
    return { status: "skip", reason: "no_variant_limits" };
  }

  if (fileWidthInch == null || fileHeightInch == null) {
    return { status: "skip", reason: "missing_file_dimensions" };
  }

  const fileW = fileWidthInch;
  const fileH = fileHeightInch;

  if (maxWidthInch != null && maxHeightInch != null) {
    if (fitsBothLimits(fileW, fileH, maxWidthInch, maxHeightInch)) {
      return { status: "pass" };
    }
    return {
      status: "fail",
      ruleCode: VARIANT_MAX_DIMENSIONS_RULE_CODE,
      message: formatVariantMaxDimensionsMessage(fileW, fileH, maxWidthInch, maxHeightInch),
      details: {
        fileWidthInch: fileW,
        fileHeightInch: fileH,
        maxWidthInch,
        maxHeightInch,
      },
    };
  }

  if (maxWidthInch != null) {
    const longEdge = Math.max(fileW, fileH);
    if (withinTolerance(longEdge, maxWidthInch)) {
      return { status: "pass" };
    }
    return {
      status: "fail",
      ruleCode: VARIANT_MAX_DIMENSIONS_RULE_CODE,
      message: formatVariantMaxDimensionsMessage(fileW, fileH, maxWidthInch),
      details: {
        fileWidthInch: fileW,
        fileHeightInch: fileH,
        maxWidthInch,
      },
    };
  }

  const longEdge = Math.max(fileW, fileH);
  if (withinTolerance(longEdge, maxHeightInch!)) {
    return { status: "pass" };
  }
  return {
    status: "fail",
    ruleCode: VARIANT_MAX_DIMENSIONS_RULE_CODE,
    message: formatVariantMaxDimensionsMessage(fileW, fileH, undefined, maxHeightInch),
    details: {
      fileWidthInch: fileW,
      fileHeightInch: fileH,
      maxHeightInch,
    },
  };
}
