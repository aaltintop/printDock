import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";

type SetupState = {
  themeBlockEnabled: boolean;
  themeVerificationUnavailable: boolean;
  themeVerificationMessage: string | null;
  cartValidationVerified: boolean;
  cartTransformVerified: boolean;
  fieldsConfigured: boolean;
  themeEditorUrl: string;
};

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

async function detectThemeBlockEnabled(
  admin: any,
): Promise<{
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
    const themes: ThemeNode[] = json?.data?.themes?.edges?.map((edge: any) => edge.node) ?? [];
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

    console.error("Theme block status check failed:", error);
    return {
      enabled: false,
      themeId: null,
      verificationUnavailable: true,
      verificationMessage: "Theme block verification failed. Please verify block placement manually.",
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shopSettingsDoc = await db.collection("shops").doc(shopDomain).get();
  const shopSettings = shopSettingsDoc.data() ?? {};
  const fieldsSnapshot = await db
    .collection("shops")
    .doc(shopDomain)
    .collection("fields")
    .limit(1)
    .get();

  const {
    enabled: themeBlockEnabled,
    themeId,
    verificationUnavailable,
    verificationMessage,
  } = await detectThemeBlockEnabled(admin);
  const fieldsConfigured = !fieldsSnapshot.empty;
  const themeEditorUrl = themeId
    ? `https://${shopDomain}/admin/themes/${themeId.replace("gid://shopify/OnlineStoreTheme/", "")}/editor?context=apps`
    : `https://${shopDomain}/admin/themes`;

  const setup: SetupState = {
    themeBlockEnabled,
    themeVerificationUnavailable: verificationUnavailable,
    themeVerificationMessage: verificationMessage,
    fieldsConfigured,
    cartValidationVerified: Boolean(shopSettings.cartValidationVerified),
    cartTransformVerified: Boolean(shopSettings.cartTransformVerified),
    themeEditorUrl,
  };

  const setupComplete =
    (setup.themeVerificationUnavailable || setup.themeBlockEnabled) &&
    setup.fieldsConfigured &&
    setup.cartValidationVerified &&
    setup.cartTransformVerified;

  return data({ setup, setupComplete });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shopDoc = db.collection("shops").doc(session.shop);

  if (intent === "verify_cart_validation") {
    await shopDoc.set({ cartValidationVerified: true }, { merge: true });
    return data({ ok: true });
  }

  if (intent === "verify_cart_transform") {
    await shopDoc.set({ cartTransformVerified: true }, { merge: true });
    return data({ ok: true });
  }

  return data({ ok: false }, { status: 400 });
};

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <s-badge tone={enabled ? "success" : "neutral"}>
      {enabled ? "Setup Verified" : "Waiting for Setup"}
    </s-badge>
  );
}

export default function OnboardingPage() {
  const { setup, setupComplete } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading="PrintDock Setup">
      <s-stack direction="block" gap="base">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="inline" alignItems="center" justifyContent="space-between">
            <s-heading>1. Theme App Block</s-heading>
            <StatusBadge enabled={setup.themeBlockEnabled} />
          </s-stack>
          <s-paragraph>
            Add and enable the PrintDock block in your product template.
          </s-paragraph>
          {setup.themeVerificationUnavailable && setup.themeVerificationMessage ? (
            <s-paragraph>{setup.themeVerificationMessage}</s-paragraph>
          ) : null}
          <s-button href={setup.themeEditorUrl} target="_blank">
            Open Theme Editor
          </s-button>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="inline" alignItems="center" justifyContent="space-between">
            <s-heading>2. Cart Validation</s-heading>
            <StatusBadge enabled={setup.cartValidationVerified} />
          </s-stack>
          <s-paragraph>
            Confirm your cart validation safeguards are configured.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="verify_cart_validation" />
            <s-button
              type="submit"
              {...(fetcher.state === "submitting" ? { loading: true } : {})}
            >
              Mark as Verified
            </s-button>
          </fetcher.Form>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="inline" alignItems="center" justifyContent="space-between">
            <s-heading>3. Cart Transform</s-heading>
            <StatusBadge enabled={setup.cartTransformVerified} />
          </s-stack>
          <s-paragraph>
            Confirm cart transform pricing behavior is enabled.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="verify_cart_transform" />
            <s-button
              type="submit"
              {...(fetcher.state === "submitting" ? { loading: true } : {})}
            >
              Mark as Verified
            </s-button>
          </fetcher.Form>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="inline" alignItems="center" justifyContent="space-between">
            <s-heading>4. First Upload Field</s-heading>
            <StatusBadge enabled={setup.fieldsConfigured} />
          </s-stack>
          <s-paragraph>
            Create at least one active upload field for a product.
          </s-paragraph>
          <s-button href="/app/fields/new">Create Field</s-button>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Next Step</s-heading>
          <s-paragraph>
            Continue when all setup checks are verified.
          </s-paragraph>
          <s-button
            href={setupComplete ? "/app/fields" : undefined}
            disabled={!setupComplete}
            tone={setupComplete ? "critical" : "neutral"}
          >
            {setupComplete ? "Go to Upload Fields" : "Complete Setup First"}
          </s-button>
        </s-box>
      </s-stack>
    </s-page>
  );
}

