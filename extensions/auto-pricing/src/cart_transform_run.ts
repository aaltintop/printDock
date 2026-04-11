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
    const totalPrice = Number(line.priceAttribute?.value ?? "");
    if (!hasSession || !Number.isFinite(totalPrice) || totalPrice <= 0) {
      continue;
    }

    const safeQuantity = Math.max(1, Number(line.quantity || 1));
    const unitPrice = Math.round((totalPrice / safeQuantity) * 100) / 100;
    if (unitPrice <= 0) continue;

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: unitPrice.toFixed(2),
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