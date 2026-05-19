import { log } from "../lib/logger.server";

/** Must match `extensions/cart-fee-validation/shopify.extension.toml` handle. */
export const PRINTDOCK_CART_VALIDATION_FUNCTION_HANDLE = "cart-fee-validation";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type CartValidationStatusCode =
  | "active"
  | "missing"
  | "missing_scope"
  | "function_not_deployed"
  | "permission_denied"
  | "verification_unavailable"
  | "unknown_error";

export interface CartValidationStatus {
  code: CartValidationStatusCode;
  enabled: boolean;
  validationId: string | null;
  message: string | null;
}

export interface RegisterCartValidationResult extends CartValidationStatus {
  created: boolean;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    return typeof msg === "string" ? msg : String(msg ?? "");
  }
  return "";
}

export async function detectPrintDockCartValidation(
  admin: AdminLike,
): Promise<CartValidationStatus> {
  try {
    const response = await admin.graphql(
      `#graphql
      query PrintDockCartValidations {
        validations(first: 25) {
          nodes {
            id
            enabled
            shopifyFunction {
              handle
            }
          }
        }
      }`,
    );
    const json = await response.json();
    const nodes = Array.isArray(json?.data?.validations?.nodes)
      ? (json.data.validations.nodes as Array<{
          id?: string;
          enabled?: boolean;
          shopifyFunction?: { handle?: string };
        }>)
      : [];

    const match = nodes.find(
      (node) =>
        String(node?.shopifyFunction?.handle || "") === PRINTDOCK_CART_VALIDATION_FUNCTION_HANDLE,
    );
    if (match?.id) {
      return {
        code: "active",
        enabled: Boolean(match.enabled),
        validationId: String(match.id),
        message: null,
      };
    }

    return {
      code: "missing",
      enabled: false,
      validationId: null,
      message: null,
    };
  } catch (error) {
    const message = readErrorMessage(error);
    log.error("cart_validation_detect_failed", error, {});
    return {
      code: "verification_unavailable",
      enabled: false,
      validationId: null,
      message: message || "Could not verify cart validation status.",
    };
  }
}

export async function registerPrintDockCartValidation(
  admin: AdminLike,
): Promise<RegisterCartValidationResult> {
  const existing = await detectPrintDockCartValidation(admin);
  if (existing.enabled && existing.validationId) {
    return { ...existing, created: false };
  }

  try {
    const response = await admin.graphql(
      `#graphql
      mutation PrintDockRegisterCartValidation($functionHandle: String!) {
        validationCreate(validation: { functionHandle: $functionHandle, blockOnFailure: true }) {
          validation {
            id
            enabled
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          functionHandle: PRINTDOCK_CART_VALIDATION_FUNCTION_HANDLE,
        },
      },
    );

    const json = await response.json();
    const userErrors = Array.isArray(json?.data?.validationCreate?.userErrors)
      ? json.data.validationCreate.userErrors
      : [];
    if (userErrors.length > 0) {
      const msg = String(userErrors[0]?.message || "validationCreate failed");
      log.warn("cart_validation_register_user_error", msg, { userErrors });
      return {
        code: "unknown_error",
        enabled: false,
        validationId: null,
        message: msg,
        created: false,
      };
    }

    const created = json?.data?.validationCreate?.validation;
    if (created?.id) {
      log.event("cart_validation_registered", { validationId: String(created.id) });
      return {
        code: "active",
        enabled: Boolean(created.enabled),
        validationId: String(created.id),
        message: null,
        created: true,
      };
    }

    return {
      code: "unknown_error",
      enabled: false,
      validationId: null,
      message: "Shopify did not return a validation id.",
      created: false,
    };
  } catch (error) {
    log.error("cart_validation_register_failed", error, {});
    return {
      code: "unknown_error",
      enabled: false,
      validationId: null,
      message: readErrorMessage(error) || "Could not register cart validation.",
      created: false,
    };
  }
}
