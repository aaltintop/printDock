import type {
  FieldTargetCollection,
  FieldTargetProduct,
  UploadFieldConfig,
} from "../types/printdock";

export type OverlapFieldRef = {
  id: string;
  adminTitle: string;
};

export type ProductTargetOverlapRow = {
  productId: string;
  /** Best-effort title from field target metadata */
  label: string;
  fields: OverlapFieldRef[];
};

export type CollectionTargetOverlapRow = {
  collectionId: string;
  label: string;
  fields: OverlapFieldRef[];
};

export type ActiveTargetOverlapAnalysis = {
  hasOverlap: boolean;
  overlappingProducts: ProductTargetOverlapRow[];
  overlappingCollections: CollectionTargetOverlapRow[];
};

function productIdsForField(field: UploadFieldConfig): string[] {
  const ids = new Set<string>();
  for (const id of field.targetProductIds ?? []) {
    if (id) ids.add(id);
  }
  if (field.productId) ids.add(field.productId);
  return [...ids];
}

function collectionIdsForField(field: UploadFieldConfig): string[] {
  return (field.targetCollectionIds ?? []).filter(Boolean);
}

function productLabelFromFields(productId: string, active: readonly UploadFieldConfig[]): string {
  for (const f of active) {
    const p = f.targetProducts?.find((tp) => tp.id === productId);
    if (p?.title?.trim()) return p.title.trim();
  }
  return `Product ID ${productId}`;
}

function collectionLabelFromFields(
  collectionId: string,
  active: readonly UploadFieldConfig[],
): string {
  for (const f of active) {
    const c = f.targetCollections?.find((tc) => tc.id === collectionId);
    if (c?.title?.trim()) return c.title.trim();
  }
  return `Collection ID ${collectionId}`;
}

function fieldRefsFromIds(
  fieldIds: Iterable<string>,
  fieldById: ReadonlyMap<string, UploadFieldConfig>,
): OverlapFieldRef[] {
  return [...fieldIds]
    .map((id) => {
      const f = fieldById.get(id);
      return f ? { id: f.id, adminTitle: f.adminTitle } : null;
    })
    .filter((r): r is OverlapFieldRef => r !== null)
    .sort((a, b) => a.adminTitle.localeCompare(b.adminTitle));
}

/** Lists products and collections targeted by more than one active field, with field names. */
export function analyzeActiveFieldTargetOverlaps(
  fields: readonly UploadFieldConfig[],
): ActiveTargetOverlapAnalysis {
  const active = fields.filter((f) => f.isActive);
  const fieldById = new Map(active.map((f) => [f.id, f] as const));

  const productToFieldIds = new Map<string, Set<string>>();
  const collectionToFieldIds = new Map<string, Set<string>>();

  for (const f of active) {
    for (const pid of productIdsForField(f)) {
      if (!productToFieldIds.has(pid)) productToFieldIds.set(pid, new Set());
      productToFieldIds.get(pid)!.add(f.id);
    }
    for (const cid of collectionIdsForField(f)) {
      if (!collectionToFieldIds.has(cid)) collectionToFieldIds.set(cid, new Set());
      collectionToFieldIds.get(cid)!.add(f.id);
    }
  }

  const overlappingProducts: ProductTargetOverlapRow[] = [];
  for (const [productId, idSet] of productToFieldIds) {
    if (idSet.size <= 1) continue;
    overlappingProducts.push({
      productId,
      label: productLabelFromFields(productId, active),
      fields: fieldRefsFromIds(idSet, fieldById),
    });
  }
  overlappingProducts.sort((a, b) => a.label.localeCompare(b.label));

  const overlappingCollections: CollectionTargetOverlapRow[] = [];
  for (const [collectionId, idSet] of collectionToFieldIds) {
    if (idSet.size <= 1) continue;
    overlappingCollections.push({
      collectionId,
      label: collectionLabelFromFields(collectionId, active),
      fields: fieldRefsFromIds(idSet, fieldById),
    });
  }
  overlappingCollections.sort((a, b) => a.label.localeCompare(b.label));

  return {
    hasOverlap: overlappingProducts.length > 0 || overlappingCollections.length > 0,
    overlappingProducts,
    overlappingCollections,
  };
}

/** True when this field is active and shares at least one product or collection target with another active field. */
export function activeFieldParticipatesInTargetOverlap(
  field: UploadFieldConfig,
  allFields: readonly UploadFieldConfig[],
): boolean {
  if (!field.isActive) return false;
  const activeOthers = allFields.filter((f) => f.isActive && f.id !== field.id);
  if (activeOthers.length === 0) return false;

  const myProducts = new Set(productIdsForField(field));
  const myCollections = new Set(collectionIdsForField(field));
  if (myProducts.size === 0 && myCollections.size === 0) return false;

  for (const other of activeOthers) {
    for (const pid of productIdsForField(other)) {
      if (myProducts.has(pid)) return true;
    }
    for (const cid of collectionIdsForField(other)) {
      if (myCollections.has(cid)) return true;
    }
  }
  return false;
}

/** Merge unsaved targets and active flag into a field copy for overlap checks while editing. */
export function fieldWithEditorTargets(
  base: UploadFieldConfig,
  isActive: boolean,
  targetProducts: readonly FieldTargetProduct[],
  targetCollections: readonly FieldTargetCollection[],
): UploadFieldConfig {
  const targetProductIds = targetProducts.map((p) => p.id).filter(Boolean);
  const targetCollectionIds = targetCollections.map((c) => c.id).filter(Boolean);
  return {
    ...base,
    isActive,
    targetProducts: [...targetProducts],
    targetCollections: [...targetCollections],
    targetProductIds,
    targetCollectionIds,
    productId: targetProductIds[0] ?? base.productId,
  };
}
