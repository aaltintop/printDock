import type { FieldTargetProduct } from "../types/printdock";

export type ShopifyVariantRow = {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
};

export function buildKnownVariantIdsByProduct(
  variants: readonly ShopifyVariantRow[],
  products: readonly FieldTargetProduct[] = [],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const variant of variants) {
    const list = grouped.get(variant.productId) ?? [];
    list.push(variant.variantId);
    grouped.set(variant.productId, list);
  }
  for (const product of products) {
    const list = grouped.get(product.id) ?? [];
    for (const saved of product.variants ?? []) {
      if (saved.variantId) list.push(saved.variantId);
    }
    if (list.length > 0) {
      grouped.set(product.id, [...new Set(list)]);
    }
  }
  return grouped;
}
