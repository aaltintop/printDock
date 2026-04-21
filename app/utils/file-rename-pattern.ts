/**
 * Must match the fallback in webhooks.orders.create.tsx:
 * `field?.fileRenamingPattern || DEFAULT_FILE_RENAME_PATTERN`
 */
export const DEFAULT_FILE_RENAME_PATTERN = "{orderId}_{lineItemId}_{originalName}";

const PREVIEW_SAMPLE_TOKENS: Record<string, string> = {
  orderId: "5678901234",
  orderName: "#1001",
  lineItemId: "9876543210",
  variantName: "default-title",
  originalName: "my-artwork",
  fileIndex: "1",
};

export function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function applyRenamePattern(pattern: string, tokens: Record<string, string>): string {
  return pattern.replace(/\{([^}]+)\}/g, (_, token: string) => {
    const key = token.trim();
    return tokens[key] ?? "";
  });
}

/** Base filename segment after sanitization (no extension), for admin preview only. */
export function previewRenamedBase(pattern: string): string {
  const p = pattern.trim() || DEFAULT_FILE_RENAME_PATTERN;
  return sanitizeSegment(applyRenamePattern(p, PREVIEW_SAMPLE_TOKENS)) || "print_file";
}

/** Example final filename with a sample extension (preview only). */
export function previewRenamedFileName(pattern: string, sampleExtension = "pdf"): string {
  const base = previewRenamedBase(pattern);
  const ext = sampleExtension.replace(/^\./, "").toLowerCase() || "pdf";
  return `${base}.${ext}`;
}
