import { log } from "../lib/logger.server";

/**
 * Function handle of the PrintDock Cart Transform extension.
 *
 * Must stay in sync with `extensions/auto-pricing/shopify.extension.toml` `handle`.
 */
export const PRINTDOCK_CART_TRANSFORM_FUNCTION_HANDLE = "auto-pricing";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type CartTransformStatusCode =
  | "active"
  | "missing"
  | "missing_scope"
  | "function_not_deployed"
  | "permission_denied"
  | "not_supported"
  | "verification_unavailable"
  | "unknown_error";

export interface CartTransformStatus {
  code: CartTransformStatusCode;
  enabled: boolean;
  cartTransformId: string | null;
  message: string | null;
}

export interface RegisterCartTransformResult extends CartTransformStatus {
  created: boolean;
}

interface GraphQLError {
  message?: string;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    return typeof msg === "string" ? msg : String(msg ?? "");
  }
  return "";
}

function classifyMessage(rawMessage: string): {
  code: CartTransformStatusCode;
  message: string;
} | null {
  const message = rawMessage.toLowerCase();
  if (!message) return null;

  if (message.includes("write_cart_transforms")) {
    return {
      code: "missing_scope",
      message:
        "PrintDock needs the `write_cart_transforms` permission to enable dynamic pricing. Reauthorize the app to grant the new scope.",
    };
  }
  if (message.includes("read_cart_transforms")) {
    return {
      code: "missing_scope",
      message:
        "PrintDock needs the `read_cart_transforms` permission to verify dynamic pricing. Reauthorize the app to grant the new scope.",
    };
  }
  if (message.includes("checkout extensibility")) {
    return {
      code: "not_supported",
      message:
        "Dynamic pricing requires Checkout Extensibility (and Shopify Plus for line price overrides). This store is not eligible for the Cart Transform.",
    };
  }
  if (
    message.includes("function does not exist") ||
    message.includes("function not found") ||
    (message.includes("function") && message.includes("not deployed"))
  ) {
    return {
      code: "function_not_deployed",
      message:
        "The PrintDock pricing function is not deployed for this store yet. Run `shopify app deploy` and reinstall the app on the store.",
    };
  }
  if (
    message.includes("function_handle") ||
    message.includes("functionhandle") ||
    (message.includes("function") && message.includes("handle"))
  ) {
    return {
      code: "function_not_deployed",
      message:
        "Shopify could not find a deployed function with handle `auto-pricing`. Run `shopify app deploy` to publish it.",
    };
  }
  if (message.includes("access denied") || message.includes("permission")) {
    return {
      code: "permission_denied",
      message:
        "Shopify denied access to Cart Transform APIs for this store. Confirm the user installing PrintDock has products and preferences permissions.",
    };
  }
  if (
    message.includes("cannot query field") ||
    message.includes("field does not exist")
  ) {
    return {
      code: "verification_unavailable",
      message:
        "Cart Transform APIs are not available for this store. Verify dynamic pricing manually in Shopify settings.",
    };
  }
  return null;
}

function classifyGraphQLErrors(errors: GraphQLError[]): {
  code: CartTransformStatusCode;
  message: string;
} | null {
  for (const error of errors) {
    const classified = classifyMessage(String(error?.message ?? ""));
    if (classified) return classified;
  }
  return errors.length > 0
    ? {
        code: "unknown_error",
        message: String(errors[0]?.message ?? "Unexpected Cart Transform error."),
      }
    : null;
}

export async function detectPrintDockCartTransform(
  admin: AdminLike,
): Promise<CartTransformStatus> {
  try {
    const response = await admin.graphql(`
    #graphql
    query PrintDockCartTransforms {
      cartTransforms(first: 25) {
        nodes {
          id
          functionId
          blockOnFailure
        }
      }
    }
  `);

    const json = await response.json();
    const errors: GraphQLError[] = Array.isArray(json?.errors) ? json.errors : [];
    const classified = classifyGraphQLErrors(errors);
    if (classified) {
      return {
        code: classified.code,
        enabled: false,
        cartTransformId: null,
        message: classified.message,
      };
    }

    const nodes = Array.isArray(json?.data?.cartTransforms?.nodes)
      ? (json.data.cartTransforms.nodes as Array<{ id?: string }>)
      : [];

    if (nodes.length === 0) {
      return {
        code: "missing",
        enabled: false,
        cartTransformId: null,
        message:
          "PrintDock has not registered a Cart Transform on this store yet. Click 'Enable dynamic pricing' to register it.",
      };
    }

    return {
      code: "active",
      enabled: true,
      cartTransformId: String(nodes[0]?.id ?? ""),
      message: null,
    };
  } catch (error) {
    const message = readErrorMessage(error);
    const classified = classifyMessage(message);
    if (classified) {
      return {
        code: classified.code,
        enabled: false,
        cartTransformId: null,
        message: classified.message,
      };
    }
    log.error("cart_transform_detect_failed", error, {});
    return {
      code: "verification_unavailable",
      enabled: false,
      cartTransformId: null,
      message:
        "Could not check Cart Transform status right now. Try again or verify in Shopify settings.",
    };
  }
}

export async function registerPrintDockCartTransform(
  admin: AdminLike,
): Promise<RegisterCartTransformResult> {
  const existing = await detectPrintDockCartTransform(admin);
  if (existing.enabled) {
    return { ...existing, created: false };
  }
  if (
    existing.code === "missing_scope" ||
    existing.code === "permission_denied" ||
    existing.code === "verification_unavailable"
  ) {
    return { ...existing, created: false };
  }

  try {
    const response = await admin.graphql(
      `#graphql
      mutation PrintDockRegisterCartTransform(
        $functionHandle: String!
        $blockOnFailure: Boolean
      ) {
        cartTransformCreate(
          functionHandle: $functionHandle
          blockOnFailure: $blockOnFailure
        ) {
          cartTransform {
            id
            functionId
            blockOnFailure
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          functionHandle: PRINTDOCK_CART_TRANSFORM_FUNCTION_HANDLE,
          blockOnFailure: false,
        },
      },
    );

    const json = await response.json();
    const errors: GraphQLError[] = Array.isArray(json?.errors) ? json.errors : [];
    const classifiedTopLevel = classifyGraphQLErrors(errors);
    if (classifiedTopLevel) {
      return {
        code: classifiedTopLevel.code,
        enabled: false,
        cartTransformId: null,
        message: classifiedTopLevel.message,
        created: false,
      };
    }

    const userErrors = Array.isArray(json?.data?.cartTransformCreate?.userErrors)
      ? (json.data.cartTransformCreate.userErrors as Array<{ message?: string }>)
      : [];
    if (userErrors.length > 0) {
      const classifiedUser = classifyGraphQLErrors(userErrors);
      log.event("cart_transform_register_user_errors", {
        userErrors: userErrors.map((e) => String(e?.message ?? "")),
      });
      if (classifiedUser) {
        return {
          code: classifiedUser.code,
          enabled: false,
          cartTransformId: null,
          message: classifiedUser.message,
          created: false,
        };
      }
    }

    const created = json?.data?.cartTransformCreate?.cartTransform;
    if (created?.id) {
      log.event("cart_transform_registered", {
        cartTransformId: String(created.id),
      });
      return {
        code: "active",
        enabled: true,
        cartTransformId: String(created.id),
        message: null,
        created: true,
      };
    }

    return {
      code: "unknown_error",
      enabled: false,
      cartTransformId: null,
      message:
        "Shopify accepted the request but did not return a Cart Transform. Try again or verify in Shopify settings.",
      created: false,
    };
  } catch (error) {
    const message = readErrorMessage(error);
    const classified = classifyMessage(message);
    if (classified) {
      return {
        code: classified.code,
        enabled: false,
        cartTransformId: null,
        message: classified.message,
        created: false,
      };
    }
    log.error("cart_transform_register_failed", error, {});
    return {
      code: "unknown_error",
      enabled: false,
      cartTransformId: null,
      message:
        "Could not register the Cart Transform right now. Check the app logs and try again.",
      created: false,
    };
  }
}
