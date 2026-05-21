import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { fileTypeFromBuffer } from "file-type";
import {
  DPI_HEURISTIC_FLOOR,
  readAuthoritativeDpi,
} from "./image-dpi.server";

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
  ruleCode?: string;
  severity: "blocking" | "warning";
  message: string;
  actual: number | null;
  expected: number;
  details?: Record<string, unknown>;
}

const MAX_FILE_SIZE_MB = 500;
const MAX_PIXELS = 10000 * 10000; // 100 Megapixels max to prevent decompression bombs

/**
 * Stable error codes returned by `extractMetadata`. Endpoints translate
 * these into shopper-friendly messages (see `app/lib/api-error.server.ts`).
 * The raw underlying error message (e.g. sharp/pdf-lib internals) is logged
 * server-side but never propagated to the storefront.
 */
export type ExtractMetadataErrorCode =
  | "file_too_large_global"
  | "file_unreadable";

export interface ExtractMetadataResult {
  metadata: FileMetadata;
  actualMimeType: string;
  errorCode?: ExtractMetadataErrorCode;
  /** Raw underlying error (for server logs only — DO NOT send to client). */
  rawError?: string;
}

export async function extractMetadata(
  buffer: Buffer,
  declaredMimeType: string,
  fileSizeBytes: number
): Promise<ExtractMetadataResult> {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    return {
      metadata: createEmptyMetadata(fileSizeMB),
      actualMimeType: declaredMimeType,
      errorCode: "file_too_large_global",
    };
  }

  // MIME sniffing
  const fileType = await fileTypeFromBuffer(buffer);
  const actualMimeType = fileType?.mime || declaredMimeType;

  try {
    if (actualMimeType.startsWith("image/")) {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      const dpi = resolveImageDpi(buffer, actualMimeType, meta.density ?? null);
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
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    return {
      metadata: createEmptyMetadata(fileSizeMB),
      actualMimeType,
      errorCode: "file_unreadable",
      rawError,
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

/**
 * Pick the most trustworthy DPI for the given buffer.
 *
 * Step 1 (authoritative): for formats we parse ourselves (PNG `pHYs`,
 *   JPEG JFIF APP0), use the binary reader and IGNORE sharp's value.
 *   libvips fabricates a fallback (≈25 DPI for PNG, 72 for JPEG) when
 *   no metadata is embedded, which silently breaks inch-based rules
 *   and pricing.
 *
 * Step 2 (heuristic floor): regardless of which source we used, drop
 *   any density below ~30 DPI back to null. Two reasons:
 *     • sharp's PNG encoder writes a default `pHYs` chunk of 1000 ppm
 *       (≈25.4 DPI) when no density is requested — so a PNG that the
 *       merchant or another tool "exported without DPI" ends up
 *       carrying an authoritative-looking 25 DPI tag. There is no way
 *       to distinguish that from a deliberate 25 DPI value short of a
 *       floor check, and virtually no legitimate print file is under
 *       30 DPI.
 *     • Same applies to WebP/TIFF/GIF where libvips may report similar
 *       fallback densities.
 */
function resolveImageDpi(
  buffer: Buffer,
  mimeType: string,
  sharpDpi: number | null,
): number | null {
  const auth = readAuthoritativeDpi(buffer, mimeType);
  const candidate = auth.supported ? auth.dpi : sharpDpi;
  if (candidate == null) return null;
  if (candidate < DPI_HEURISTIC_FLOOR) return null;
  return candidate;
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
