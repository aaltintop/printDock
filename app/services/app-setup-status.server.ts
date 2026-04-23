import { db } from "../firebase.server";
import { log } from "../lib/logger.server";
import { listUploadFields } from "./shop-data.server";

type ThemeNode = {
  id: string;
  role: string;
  files?: {
    edges?: Array<{
      node?: {
        body?: {
          content?: string;
        };
      };
    }>;
  };
};

function isReadThemesScopeError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || "");
  return (
    message.includes("Access denied for themes field") ||
    message.includes("`read_themes`") ||
    message.includes("read_themes")
  );
}

function isCartTransformVerificationUnavailable(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || "");
  return (
    message.includes("Cannot query field \"cartTransforms\"") ||
    message.includes("Access denied") ||
    message.includes("access denied") ||
    message.includes("permission")
  );
}

/** Detects whether the theme app upload block appears in the live theme settings. */
export async function detectThemeBlockEnabled(admin: {
  graphql: (query: string) => Promise<Response>;
}): Promise<{
  enabled: boolean;
  themeId: string | null;
  verificationUnavailable: boolean;
  verificationMessage: string | null;
}> {
  try {
    const response = await admin.graphql(`
    #graphql
    query OnboardingThemeStatus {
      themes(first: 20) {
        edges {
          node {
            id
            role
            files(filenames: ["config/settings_data.json"]) {
              edges {
                node {
                  ... on OnlineStoreThemeFile {
                    body {
                      ... on OnlineStoreThemeFileBodyText {
                        content
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

    const json = await response.json();
    const edges = json?.data?.themes?.edges as Array<{ node?: ThemeNode }> | undefined;
    const themes: ThemeNode[] = edges?.map((edge) => edge.node).filter((n): n is ThemeNode => Boolean(n)) ?? [];
    const mainTheme = themes.find((theme) => theme.role === "MAIN") ?? themes[0];
    if (!mainTheme) {
      return {
        enabled: false,
        themeId: null,
        verificationUnavailable: false,
        verificationMessage: null,
      };
    }

    const settingsContent = mainTheme.files?.edges?.[0]?.node?.body?.content ?? "";
    const enabled =
      settingsContent.includes("shopify://apps/printdock/blocks/upload/") ||
      settingsContent.includes("printdock-upload");

    return {
      enabled,
      themeId: mainTheme.id,
      verificationUnavailable: false,
      verificationMessage: null,
    };
  } catch (error) {
    if (isReadThemesScopeError(error)) {
      return {
        enabled: false,
        themeId: null,
        verificationUnavailable: true,
        verificationMessage:
          "Automatic theme block verification is unavailable. Add `read_themes` scope and reauthorize the app.",
      };
    }

    log.error("theme_block_status_check_failed", error, {});
    return {
      enabled: false,
      themeId: null,
      verificationUnavailable: true,
      verificationMessage: "Theme block verification failed. Please verify block placement manually.",
    };
  }
}

/** Detects whether at least one cart transform exists for the app installation. */
export async function detectCartTransformActive(admin: {
  graphql: (query: string) => Promise<Response>;
}): Promise<{
  enabled: boolean;
  verificationUnavailable: boolean;
  verificationMessage: string | null;
}> {
  try {
    const response = await admin.graphql(`
    #graphql
    query PrintDockCartTransforms {
      cartTransforms(first: 25) {
        nodes {
          id
        }
      }
    }
  `);

    const json = await response.json();
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    if (errors.length > 0) {
      const firstMessage = String(errors[0]?.message ?? "Unknown error");
      if (isCartTransformVerificationUnavailable({ message: firstMessage })) {
        return {
          enabled: false,
          verificationUnavailable: true,
          verificationMessage:
            "Automatic Cart Transform verification is unavailable for this shop. Verify it manually in Shopify settings.",
        };
      }
      throw new Error(firstMessage);
    }

    const nodes = Array.isArray(json?.data?.cartTransforms?.nodes)
      ? json.data.cartTransforms.nodes
      : [];
    return {
      enabled: nodes.length > 0,
      verificationUnavailable: false,
      verificationMessage: null,
    };
  } catch (error) {
    if (isCartTransformVerificationUnavailable(error)) {
      return {
        enabled: false,
        verificationUnavailable: true,
        verificationMessage:
          "Automatic Cart Transform verification is unavailable for this shop. Verify it manually in Shopify settings.",
      };
    }

    log.error("cart_transform_status_check_failed", error, {});
    return {
      enabled: false,
      verificationUnavailable: true,
      verificationMessage: "Cart Transform verification failed. Please verify manually.",
    };
  }
}

/** True when theme step, first field, cart validation, and cart transform are all satisfied (matches onboarding `setupComplete`). */
export async function isAppSetupComplete(
  admin: { graphql: (query: string) => Promise<Response> },
  shopDomain: string,
): Promise<boolean> {
  const shopSettingsDoc = await db.collection("shops").doc(shopDomain).get();
  const shopSettings = shopSettingsDoc.data() ?? {};
  const fields = await listUploadFields(shopDomain);

  const { enabled: themeBlockEnabled, verificationUnavailable } = await detectThemeBlockEnabled(admin);
  const { enabled: cartTransformEnabled } = await detectCartTransformActive(admin);
  const fieldsConfigured = fields.length > 0;
  const cartValidationVerified =
    fields.some((field) => field.isRequired === true) || Boolean(shopSettings.cartValidationVerified);
  const cartTransformVerified =
    cartTransformEnabled || Boolean(shopSettings.cartTransformVerified);
  const themeStepVerified =
    verificationUnavailable ||
    themeBlockEnabled ||
    Boolean(shopSettings.themeBlockVerified);

  return Boolean(
    themeStepVerified &&
      fieldsConfigured &&
      cartValidationVerified &&
      cartTransformVerified,
  );
}

/** Routes merchants may open while setup is still incomplete (finish wizard + billing + fields). */
export function isPathExemptFromSetupRedirect(pathname: string): boolean {
  if (pathname === "/app/onboarding" || pathname.startsWith("/app/onboarding/")) return true;
  if (pathname === "/app/fields" || pathname.startsWith("/app/fields/")) return true;
  if (pathname === "/app/plans" || pathname.startsWith("/app/plans/")) return true;
  return false;
}
