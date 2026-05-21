const DIMENSION_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i;

export function parseVariantDimensions(
  title: string,
): { width: number; height: number } | null {
  if (!title) return null;
  const match = DIMENSION_RE.exec(title);
  if (!match || match.index === undefined) return null;
  if (match.index > 0 && title[match.index - 1] === "-") return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
