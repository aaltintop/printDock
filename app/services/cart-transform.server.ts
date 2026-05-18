import { log } from "../lib/logger.server";
import {
  ensureHmacSecret,
  getHmacSecretFromFirestore,
  mirrorHmacSecretToCartTransformOwner,
} from "./shop-secret.server";

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

export interface CartTransformConflictStatus {
  hasConflict: boolean;
  existingCartTransformId: string | null;
  message: string | null;
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
      code: "verification_unavailable",
      message:
        "This store does not expose Cart Transform APIs to PrintDock right now. Verify settings in Shopify admin and try again.",
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

async function mirrorHmacToActiveCartTransformIfPossible(
  admin: AdminLike,
  shopDomain: string | undefined,
  cartTransformId: string | null,
): Promise<void> {
  if (!shopDomain || !cartTransformId) return;
  const key = await getHmacSecretFromFirestore(shopDomain);
  if (!key) return;
  const result = await mirrorHmacSecretToCartTransformOwner(admin, cartTransformId, key);
  if (!result.ok) {
    log.warn(
      "printdock_cart_transform_hmac_mirror_failed",
      String(result.message || "unknown"),
      { cartTransformId },
    );
  }
}

/**
 * Ensures the Cart Transform function input can read the HMAC on the transform owner
 * (`cartTransform.pricingHmac`). Idempotent; safe to call from app loaders.
 */
export async function syncPrintDockCartTransformHmacMirror(
  admin: AdminLike,
  shopDomain: string,
): Promise<void> {
  const status = await detectPrintDockCartTransform(admin);
  if (!status.enabled || !status.cartTransformId) return;
  await mirrorHmacToActiveCartTransformIfPossible(admin, shopDomain, status.cartTransformId);
}

/**
 * Returns the gid of the *currently deployed* PrintDock cart-transform function
 * (the one whose handle in the app's `shopify.extension.toml` matches
 * `PRINTDOCK_CART_TRANSFORM_FUNCTION_HANDLE`).
 *
 * Returns `null` if the function is missing or the query failed — callers
 * should treat that as "unknown" and avoid mutating cart transforms.
 */
async function getActivePrintDockFunctionId(admin: AdminLike): Promise<string | null> {
  try {
    const response = await admin.graphql(`#graphql
      query PrintDockActiveFunction {
        shopifyFunctions(apiType: "cart_transform", first: 25) {
          nodes {
            id
            handle
            apiType
          }
        }
      }
    `);
    const json = await response.json();
    const nodes = Array.isArray(json?.data?.shopifyFunctions?.nodes)
      ? (json.data.shopifyFunctions.nodes as Array<{ id?: string; handle?: string }>)
      : [];
    const match = nodes.find(
      (n) => String(n?.handle ?? "") === PRINTDOCK_CART_TRANSFORM_FUNCTION_HANDLE,
    );
    return match?.id ? String(match.id) : null;
  } catch (error) {
    log.warn(
      "cart_transform_active_function_lookup_failed",
      error instanceof Error ? error.message : String(error),
      {},
    );
    return null;
  }
}

/**
 * Deletes a Cart Transform by gid. Returns true on success, false otherwise.
 * Logs the outcome either way.
 */
async function deleteCartTransform(admin: AdminLike, cartTransformId: string): Promise<boolean> {
  try {
    const response = await admin.graphql(
      `#graphql
      mutation PrintDockCartTransformDelete($id: ID!) {
        cartTransformDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { id: cartTransformId } },
    );
    const json = await response.json();
    const userErrors = Array.isArray(json?.data?.cartTransformDelete?.userErrors)
      ? (json.data.cartTransformDelete.userErrors as Array<{ message?: string }>)
      : [];
    if (userErrors.length > 0) {
      log.warn(
        "cart_transform_delete_user_errors",
        userErrors.map((e) => String(e?.message ?? "")).join("; "),
        { cartTransformId },
      );
      return false;
    }
    const deletedId = json?.data?.cartTransformDelete?.deletedId;
    if (deletedId) {
      log.event("cart_transform_deleted", { cartTransformId: String(deletedId) });
      return true;
    }
    return false;
  } catch (error) {
    log.error("cart_transform_delete_failed", error, { cartTransformId });
    return false;
  }
}

/**
 * Purges PrintDock-owned Cart Transforms that are bound to a *stale* function.
 *
 * Why this matters: when we replaced the JS cart-transform with the Rust one
 * (different export name → different functionId), Shopify did not rebind the
 * existing Cart Transform, so it continued invoking the dead JS function and
 * timing out at 11M instructions. After purging, `registerPrintDockCartTransform`
 * recreates the CT bound to the current (Rust) function via `functionHandle`.
 *
 * Idempotent: a no-op when every CT already points at the current function ID,
 * or when we can't determine the function ID (we never delete blindly).
 */
async function purgeStalePrintDockCartTransforms(admin: AdminLike): Promise<void> {
  const currentFunctionId = await getActivePrintDockFunctionId(admin);
  if (!currentFunctionId) return;

  try {
    const response = await admin.graphql(`#graphql
      query PrintDockCartTransformsForRebind {
        cartTransforms(first: 25) {
          nodes {
            id
            functionId
          }
        }
      }
    `);
    const json = await response.json();
    const nodes = Array.isArray(json?.data?.cartTransforms?.nodes)
      ? (json.data.cartTransforms.nodes as Array<{ id?: string; functionId?: string }>)
      : [];
    const stale = nodes.filter(
      (n) => Boolean(n?.id) && String(n?.functionId ?? "") !== currentFunctionId,
    );
    if (stale.length === 0) return;

    log.event("cart_transform_stale_detected", {
      currentFunctionId,
      staleCount: stale.length,
      staleIds: stale.map((s) => String(s.id ?? "")),
    });

    for (const ct of stale) {
      if (!ct.id) continue;
      await deleteCartTransform(admin, String(ct.id));
    }
  } catch (error) {
    log.warn(
      "cart_transform_purge_stale_failed",
      error instanceof Error ? error.message : String(error),
      {},
    );
  }
}

/**
 * Self-heal helper for stores where onboarding never completed:
 * ensure the HMAC key exists and register/mirror the PrintDock cart transform.
 */
export async function ensurePrintDockCartTransformReady(
  admin: AdminLike,
  shopDomain: string,
): Promise<RegisterCartTransformResult | null> {
  try {
    await ensureHmacSecret(admin, shopDomain);
  } catch (error) {
    log.warn(
      "cart_transform_autoheal_hmac_failed",
      error instanceof Error ? error.message : String(error),
      { shopDomain },
    );
    return null;
  }

  await purgeStalePrintDockCartTransforms(admin);

  const conflict = await detectCartTransformConflict(admin);
  if (conflict.hasConflict) {
    log.warn("cart_transform_autoheal_conflict", String(conflict.message || "conflict"), { shopDomain });
    return null;
  }

  const result = await registerPrintDockCartTransform(admin, shopDomain);
  if (!result.enabled) {
    log.warn("cart_transform_autoheal_register_failed", String(result.message || result.code), {
      shopDomain,
      code: result.code,
    });
  }
  return result;
}

export async function registerPrintDockCartTransform(
  admin: AdminLike,
  shopDomain?: string,
): Promise<RegisterCartTransformResult> {
  const existing = await detectPrintDockCartTransform(admin);
  if (existing.enabled) {
    await mirrorHmacToActiveCartTransformIfPossible(admin, shopDomain, existing.cartTransformId);
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
      await mirrorHmacToActiveCartTransformIfPossible(admin, shopDomain, String(created.id));
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

export async function detectCartTransformConflict(
  admin: AdminLike,
): Promise<CartTransformConflictStatus> {
  try {
    const response = await admin.graphql(`
      #graphql
      query PrintDockCartTransformConflict {
        cartTransforms(first: 25) {
          nodes {
            id
            functionId
          }
        }
      }
    `);
    const json = await response.json();
    const nodes = Array.isArray(json?.data?.cartTransforms?.nodes)
      ? (json.data.cartTransforms.nodes as Array<{ id?: string; functionId?: string }>)
      : [];
    if (nodes.length === 0) {
      return { hasConflict: false, existingCartTransformId: null, message: null };
    }
    if (nodes.length === 1) {
      return { hasConflict: false, existingCartTransformId: String(nodes[0]?.id || ""), message: null };
    }
    return {
      hasConflict: true,
      existingCartTransformId: String(nodes[0]?.id || ""),
      message:
        "Another app already manages Cart Transform operations on this store. Disable the other Cart Transform app before enabling PrintDock upload pricing.",
    };
  } catch (error) {
    log.error("cart_transform_conflict_check_failed", error, {});
    return {
      hasConflict: false,
      existingCartTransformId: null,
      message: null,
    };
  }
}
