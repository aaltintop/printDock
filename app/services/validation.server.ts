import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { fileTypeFromBuffer } from "file-type";

export interface FileMetadata {
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  widthInch: number | null;
  heightInch: number | null;
  pageCount: number | null;
  fileSizeMB: number;
}

export interface ValidationRule {
  id: string;
  type: "widthPx" | "heightPx" | "dpi" | "widthInch" | "heightInch" | "pageCount" | "fileSizeMB";
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  value: number;
  action: "blocking" | "warning";
  message: string;
}

export interface ValidationResult {
  ruleId: string;
  severity: "blocking" | "warning";
  message: string;
  actual: number | null;
  expected: number;
}

const MAX_FILE_SIZE_MB = 500;
const MAX_PIXELS = 10000 * 10000; // 100 Megapixels max to prevent decompression bombs

export async function extractMetadata(
  buffer: Buffer,
  declaredMimeType: string,
  fileSizeBytes: number
): Promise<{ metadata: FileMetadata; actualMimeType: string; error?: string }> {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    return {
      metadata: createEmptyMetadata(fileSizeMB),
      actualMimeType: declaredMimeType,
      error: `File size exceeds maximum limit of ${MAX_FILE_SIZE_MB}MB`,
    };
  }

  // MIME sniffing
  const fileType = await fileTypeFromBuffer(buffer);
  const actualMimeType = fileType?.mime || declaredMimeType;

  try {
    if (actualMimeType.startsWith("image/")) {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      const dpi = meta.density ?? null;
      return {
        metadata: {
          widthPx: meta.width ?? null,
          heightPx: meta.height ?? null,
          dpi,
          widthInch: dpi && meta.width ? meta.width / dpi : null,
          heightInch: dpi && meta.height ? meta.height / dpi : null,
          pageCount: null,
          fileSizeMB: Math.round(fileSizeMB * 100) / 100,
        },
        actualMimeType,
      };
    }

    if (actualMimeType === "application/pdf") {
      const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = pdf.getPages();
      const firstPage = pages[0];
      const { width, height } = firstPage.getSize(); // in PDF points (1 point = 1/72 inch)
      
      return {
        metadata: {
          widthPx: null,
          heightPx: null,
          dpi: 72, // PDF native
          widthInch: width / 72,
          heightInch: height / 72,
          pageCount: pages.length,
          fileSizeMB: Math.round(fileSizeMB * 100) / 100,
        },
        actualMimeType,
      };
    }
  } catch (error: any) {
    return {
      metadata: createEmptyMetadata(fileSizeMB),
      actualMimeType,
      error: `Failed to parse file: ${error.message}`,
    };
  }

  // Unsupported type
  return {
    metadata: createEmptyMetadata(fileSizeMB),
    actualMimeType,
  };
}

function createEmptyMetadata(fileSizeMB: number): FileMetadata {
  return {
    widthPx: null, heightPx: null, dpi: null,
    widthInch: null, heightInch: null, pageCount: null,
    fileSizeMB: Math.round(fileSizeMB * 100) / 100,
  };
}

export function runValidationRules(
  metadata: FileMetadata,
  rules: ValidationRule[]
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const rule of rules) {
    const actual = metadata[rule.type] as number | null;
    if (actual === null) continue; // Can't check what we don't have

    // Operators in saved rules represent "valid/pass" conditions (e.g. lte = max, gte = min).
    // Trigger when the file VIOLATES that pass condition.
    const triggered = violatesRule(actual, rule.operator, rule.value);
    if (triggered) {
      results.push({
        ruleId: rule.id,
        severity: rule.action,
        message: rule.message,
        actual,
        expected: rule.value,
      });
    }
  }

  return results;
}

function checkOperator(actual: number, operator: string, expected: number): boolean {
  switch (operator) {
    case "gt":  return actual > expected;
    case "lt":  return actual < expected;
    case "eq":  return actual === expected;
    case "gte": return actual >= expected;
    case "lte": return actual <= expected;
    default:    return false;
  }
}

function violatesRule(actual: number, operator: string, expected: number): boolean {
  return !checkOperator(actual, operator, expected);
}

export function hasBlockingError(results: ValidationResult[]): boolean {
  return results.some((r) => r.severity === "blocking");
}
