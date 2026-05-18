import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type { CartTransformRunInput } from "../generated/api";
import { cartTransformRun } from "../src/cart_transform_run";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadInput(name: string): CartTransformRunInput {
  const raw = readFileSync(path.join(__dirname, "fixtures", name), "utf8");
  const parsed = JSON.parse(raw) as { payload: { input: CartTransformRunInput } };
  return parsed.payload.input;
}

describe("cartTransformRun (TS runtime)", () => {
  it("emits lineExpand for valid token", () => {
    const input = loadInput("expand-valid.json");
    const out = cartTransformRun(input);
    expect(out.operations).toHaveLength(1);
    expect(out.operations[0]).toMatchObject({
      lineExpand: {
        cartLineId: "gid://shopify/CartLine/1",
        expandedCartItems: [
          {
            merchandiseId: "gid://shopify/ProductVariant/111",
            quantity: 2,
            price: { adjustment: { fixedPricePerUnit: { amount: "12.99" } } },
          },
        ],
      },
    });
  });

  it("returns empty for invalid signature", () => {
    const input = loadInput("expand-invalid-sig.json");
    expect(cartTransformRun(input).operations).toEqual([]);
  });

  it("returns empty when no HMAC key is provided", () => {
    const input = loadInput("expand-no-hmac.json");
    expect(cartTransformRun(input).operations).toEqual([]);
  });

  it("skips lines with a selling plan", () => {
    const input = loadInput("expand-skip-selling-plan.json");
    expect(cartTransformRun(input).operations).toEqual([]);
  });
});
