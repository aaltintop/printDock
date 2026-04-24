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
    const unitPrice = Number(line.priceAttribute?.value ?? "");
    if (!hasSession || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      continue;
    }

    const rounded = Math.round(unitPrice * 100) / 100;
    if (rounded <= 0) continue;

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