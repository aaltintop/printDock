import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const operations: CartTransformRunResult["operations"] = [];

  for (const line of input.cart.lines) {
    const hasSession = Boolean(line.sessionAttribute?.value);
    const dynamicFee = Number(line.priceAttribute?.value ?? "");
    if (!hasSession || !Number.isFinite(dynamicFee) || dynamicFee <= 0) {
      continue;
    }

    const baseUnitPrice = Number(line.cost.amountPerQuantity.amount ?? "");
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
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
}