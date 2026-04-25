import { describe, expect, it, vi } from "vitest";
import {
  detectPrintDockCartTransform,
  registerPrintDockCartTransform,
} from "../../../app/services/cart-transform.server";

function makeAdmin(handler: (query: string, options?: unknown) => unknown) {
  return {
    graphql: vi.fn(async (query: string, options?: unknown) => {
      const body = handler(query, options);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  };
}

describe("detectPrintDockCartTransform", () => {
  it("returns active when a cart transform is present", async () => {
    const admin = makeAdmin(() => ({
      data: {
        cartTransforms: {
          nodes: [
            {
              id: "gid://shopify/CartTransform/1",
              functionId: "function-1",
              blockOnFailure: false,
            },
          ],
        },
      },
    }));

    const status = await detectPrintDockCartTransform(admin);

    expect(status.code).toBe("active");
    expect(status.enabled).toBe(true);
    expect(status.cartTransformId).toBe("gid://shopify/CartTransform/1");
  });

  it("returns missing when no cart transforms exist", async () => {
    const admin = makeAdmin(() => ({
      data: { cartTransforms: { nodes: [] } },
    }));

    const status = await detectPrintDockCartTransform(admin);

    expect(status.code).toBe("missing");
    expect(status.enabled).toBe(false);
    expect(status.message).toMatch(/Enable dynamic pricing|Cart Transform is not registered/);
  });

  it("classifies missing scope from GraphQL errors", async () => {
    const admin = makeAdmin(() => ({
      errors: [
        {
          message:
            "Access denied for cartTransforms field. Required access: `read_cart_transforms` access scope.",
        },
      ],
    }));

    const status = await detectPrintDockCartTransform(admin);

    expect(status.code).toBe("missing_scope");
    expect(status.enabled).toBe(false);
    expect(status.message).toMatch(/read_cart_transforms/);
  });

  it("treats schema errors as verification unavailable", async () => {
    const admin = makeAdmin(() => ({
      errors: [{ message: "Cannot query field cartTransforms on type QueryRoot" }],
    }));

    const status = await detectPrintDockCartTransform(admin);

    expect(status.code).toBe("verification_unavailable");
    expect(status.enabled).toBe(false);
  });
});

describe("registerPrintDockCartTransform", () => {
  it("returns active without re-registering when already present", async () => {
    const admin = makeAdmin((query) => {
      if (query.includes("cartTransforms")) {
        return {
          data: {
            cartTransforms: {
              nodes: [
                { id: "gid://shopify/CartTransform/1", functionId: "fn", blockOnFailure: false },
              ],
            },
          },
        };
      }
      return { data: {} };
    });

    const result = await registerPrintDockCartTransform(admin);

    expect(result.code).toBe("active");
    expect(result.enabled).toBe(true);
    expect(result.created).toBe(false);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("creates a cart transform when none exists", async () => {
    const admin = makeAdmin((query) => {
      if (query.includes("cartTransforms")) {
        return { data: { cartTransforms: { nodes: [] } } };
      }
      if (query.includes("cartTransformCreate")) {
        return {
          data: {
            cartTransformCreate: {
              cartTransform: {
                id: "gid://shopify/CartTransform/2",
                functionId: "auto-pricing",
                blockOnFailure: false,
              },
              userErrors: [],
            },
          },
        };
      }
      return { data: {} };
    });

    const result = await registerPrintDockCartTransform(admin);

    expect(result.code).toBe("active");
    expect(result.enabled).toBe(true);
    expect(result.created).toBe(true);
    expect(result.cartTransformId).toBe("gid://shopify/CartTransform/2");
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it("classifies user errors about missing function deployment", async () => {
    const admin = makeAdmin((query) => {
      if (query.includes("cartTransforms")) {
        return { data: { cartTransforms: { nodes: [] } } };
      }
      return {
        data: {
          cartTransformCreate: {
            cartTransform: null,
            userErrors: [
              {
                field: ["functionHandle"],
                message: "Function does not exist for handle auto-pricing",
              },
            ],
          },
        },
      };
    });

    const result = await registerPrintDockCartTransform(admin);

    expect(result.code).toBe("function_not_deployed");
    expect(result.enabled).toBe(false);
    expect(result.created).toBe(false);
  });

  it("does not call create when scope is missing", async () => {
    const admin = makeAdmin(() => ({
      errors: [
        {
          message: "Access denied. Missing `read_cart_transforms` access scope.",
        },
      ],
    }));

    const result = await registerPrintDockCartTransform(admin);

    expect(result.code).toBe("missing_scope");
    expect(result.created).toBe(false);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });
});
