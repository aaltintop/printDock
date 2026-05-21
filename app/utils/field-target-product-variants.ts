import type { FieldTargetProduct, FieldTargetProductVariant } from "../types/printdock";

export const VARIANT_DIMENSION_INCH_LIMITS = { min: 0.01, max: 500 } as const;

export function normalizeVariantDimensionValue(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  if (parsed < VARIANT_DIMENSION_INCH_LIMITS.min || parsed > VARIANT_DIMENSION_INCH_LIMITS.max) {
    return undefined;
  }
  return parsed;
}

export function normalizeProductVariantEntry(raw: unknown): FieldTargetProductVariant | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const variantId = String(item.variantId ?? "").trim();
  if (!variantId) return null;
  const width = normalizeVariantDimensionValue(item.width);
  const height = normalizeVariantDimensionValue(item.height);
  if (width === undefined && height === undefined) return null;
  const entry: FieldTargetProductVariant = { variantId };
  if (width !== undefined) entry.width = width;
  if (height !== undefined) entry.height = height;
  return entry;
}

export function normalizeTargetProductVariants(
  raw: unknown,
): FieldTargetProductVariant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = raw
    .map(normalizeProductVariantEntry)
    .filter((entry): entry is FieldTargetProductVariant => entry !== null);
  return result.length > 0 ? result : undefined;
}

export function normalizeTargetProductsForSave(raw: unknown): FieldTargetProduct[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((product): product is Record<string, unknown> => Boolean(product && typeof product === "object"))
    .map((product) => {
      const normalized: FieldTargetProduct = {
        id: String(product.id ?? "").trim(),
        title: String(product.title ?? ""),
        handle: String(product.handle ?? ""),
      };
      const variants = normalizeTargetProductVariants(product.variants);
      if (variants) normalized.variants = variants;
      return normalized;
    })
    .filter((product) => product.id);
}

export type VariantDimensionInputs = Record<string, { width: string; height: string }>;

export function buildVariantInputsFromProducts(
  products: readonly FieldTargetProduct[],
): VariantDimensionInputs {
  const inputs: VariantDimensionInputs = {};
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      inputs[variant.variantId] = {
        width: variant.width != null ? String(variant.width) : "",
        height: variant.height != null ? String(variant.height) : "",
      };
    }
  }
  return inputs;
}

export function applyVariantInputsToProducts(
  products: readonly FieldTargetProduct[],
  inputs: VariantDimensionInputs,
  knownVariantIdsByProduct: ReadonlyMap<string, readonly string[]>,
): FieldTargetProduct[] {
  return products.map((product) => {
    const knownVariantIds = knownVariantIdsByProduct.get(product.id) ?? [];
    const variants: FieldTargetProductVariant[] = [];

    for (const variantId of knownVariantIds) {
      const input = inputs[variantId] ?? { width: "", height: "" };
      const width = normalizeVariantDimensionValue(input.width);
      const height = normalizeVariantDimensionValue(input.height);
      if (width === undefined && height === undefined) continue;
      const entry: FieldTargetProductVariant = { variantId };
      if (width !== undefined) entry.width = width;
      if (height !== undefined) entry.height = height;
      variants.push(entry);
    }

    const normalizedVariants = normalizeTargetProductVariants(variants);
    if (!normalizedVariants) {
      const { variants: _removed, ...rest } = product;
      return rest;
    }
    return { ...product, variants: normalizedVariants };
  });
}

export function mergeVariantDimensionIntoProducts(
  products: readonly FieldTargetProduct[],
  productId: string,
  variantId: string,
  width: number | undefined,
  height: number | undefined,
): { products: FieldTargetProduct[]; variant: FieldTargetProductVariant | null } {
  const normalizedProductId = productId.trim();
  const normalizedVariantId = variantId.trim();
  if (!normalizedProductId || !normalizedVariantId) {
    return { products: [...products], variant: null };
  }

  let resultingVariant: FieldTargetProductVariant | null = null;

  const nextProducts = products.map((product) => {
    if (product.id !== normalizedProductId) return product;

    const existing = [...(product.variants ?? [])];
    const index = existing.findIndex((entry) => entry.variantId === normalizedVariantId);

    if (width === undefined && height === undefined) {
      if (index === -1) return product;
      existing.splice(index, 1);
      const normalizedVariants = normalizeTargetProductVariants(existing);
      if (!normalizedVariants) {
        const { variants: _removed, ...rest } = product;
        return rest;
      }
      return { ...product, variants: normalizedVariants };
    }

    const entry: FieldTargetProductVariant = { variantId: normalizedVariantId };
    if (width !== undefined) entry.width = width;
    if (height !== undefined) entry.height = height;
    resultingVariant = entry;

    if (index === -1) {
      existing.push(entry);
    } else {
      existing[index] = entry;
    }

    const normalizedVariants = normalizeTargetProductVariants(existing);
    if (!normalizedVariants) {
      const { variants: _removed, ...rest } = product;
      return rest;
    }
    return { ...product, variants: normalizedVariants };
  });

  return { products: nextProducts, variant: resultingVariant };
}

export function countConfiguredVariantDimensions(products: readonly FieldTargetProduct[]): number {
  let count = 0;
  for (const product of products) {
    count += product.variants?.length ?? 0;
  }
  return count;
}

export function hasConfiguredVariantDimensions(products: readonly FieldTargetProduct[]): boolean {
  return countConfiguredVariantDimensions(products) > 0;
}

export function formatVariantDimensionSummary(width?: number, height?: number): string {
  if (width != null && height != null) return `${width} × ${height} in`;
  if (width != null) return `W ${width} in`;
  if (height != null) return `H ${height} in`;
  return "";
}

export function variantInputHasSavedDimensions(input: { width: string; height: string }): boolean {
  return Boolean(input.width.trim() || input.height.trim());
}
