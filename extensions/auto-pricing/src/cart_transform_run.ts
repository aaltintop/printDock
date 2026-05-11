import type {
  CartTransformRunInput,
} from "../generated/api";

type CartTransformRunResult = {
  operations: Array<Record<string, unknown>>;
};

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

const MERGE_OPERATION_KEY =
  typeof process !== "undefined" && process.env?.PRINTDOCK_USE_MERGE === "1"
    ? "merge"
    : "linesMerge";

type InputLine = CartTransformRunInput["cart"]["lines"][number];

function merchandiseVariantId(line: InputLine): string | null {
  const merchandise = (line as unknown as { merchandise?: { id?: string } }).merchandise;
  if (!merchandise || typeof merchandise.id !== "string") return null;
  return merchandise.id;
}

function hasSellingPlan(line: InputLine): boolean {
  return Boolean(
    (line as unknown as { sellingPlanAllocation?: { sellingPlan?: { id?: string } } })
      .sellingPlanAllocation?.sellingPlan?.id,
  );
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const operations: Array<Record<string, unknown>> = [];
  const lines = Array.isArray(input?.cart?.lines) ? input.cart.lines : [];

  type SessionGroup = {
    token: string;
    artworkLine: InputLine | null;
    feeLines: InputLine[];
  };
  const groups = new Map<string, SessionGroup>();

  for (const line of lines) {
    try {
      const sessionToken = String(line.sessionAttribute?.value || "").trim();
      if (!sessionToken) continue;
      const feeForToken = String(
        (line as unknown as { feeForAttribute?: { value?: string } }).feeForAttribute?.value || "",
      ).trim();
      const existing =
        groups.get(sessionToken) ||
        ({
          token: sessionToken,
          artworkLine: null,
          feeLines: [],
        } as SessionGroup);

      if (feeForToken && feeForToken === sessionToken) {
        existing.feeLines.push(line);
      } else if (!existing.artworkLine) {
        existing.artworkLine = line;
      }
      groups.set(sessionToken, existing);
    } catch {
      continue;
    }
  }

  const groupedByParentVariant = new Map<string, number>();
  for (const group of groups.values()) {
    const artworkLine = group.artworkLine;
    if (!artworkLine || group.feeLines.length === 0) continue;
    const parentVariantId = merchandiseVariantId(artworkLine);
    if (!parentVariantId) continue;
    const hasPlan = [artworkLine, ...group.feeLines].some(hasSellingPlan);
    if (hasPlan) {
        continue;
    }
    const cartLines = [
      {
        cartLineId: artworkLine.id,
        quantity: Math.max(1, Number(artworkLine.quantity || 1)),
      },
      ...group.feeLines.map((feeLine) => ({
        cartLineId: feeLine.id,
        quantity: Math.max(1, Number(feeLine.quantity || 1)),
      })),
    ];
    if (cartLines.length < 2) continue;

    const seenCount = groupedByParentVariant.get(parentVariantId) ?? 0;
    groupedByParentVariant.set(parentVariantId, seenCount + 1);
    const mergePayload: Record<string, unknown> = {
      parentVariantId,
      cartLines,
    };
    if (seenCount > 0) {
      mergePayload.title = `Artwork - design ${seenCount + 1}`;
    }
    operations.push({
      [MERGE_OPERATION_KEY]: mergePayload,
    });
  }

  if (operations.length === 0) {
    // Fallback for shops where the merge operation key diverges from
    // docs/runtime expectations. Keep existing behavior for legacy carts
    // that still send `_pd_calculated_price` while rolling out fee lines.
    for (const line of lines) {
      try {
        const hasSession = Boolean(line.sessionAttribute?.value);
        const dynamicFee = Number(line.priceAttribute?.value ?? "");
        if (!hasSession || !Number.isFinite(dynamicFee) || dynamicFee <= 0) {
          continue;
        }
        const baseUnitPrice = Number(line.cost?.amountPerQuantity?.amount ?? "");
        if (!Number.isFinite(baseUnitPrice) || baseUnitPrice < 0) {
          continue;
        }
        const nextUnitPrice = baseUnitPrice + dynamicFee;
        const rounded = Math.round(nextUnitPrice * 100) / 100;
        if (!Number.isFinite(rounded) || rounded <= 0) continue;

        operations.push({
          lineUpdate: {
            cartLineId: line.id,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: rounded.toFixed(2),
                },
              },
            },
          },
        });
      } catch {
        continue;
      }
    }
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
}