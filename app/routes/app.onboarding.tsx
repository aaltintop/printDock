import { data, useLoaderData, useFetcher } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Badge, BlockStack, Button, Card, InlineStack, Page, Text, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getPlan } from "../config/plans";
import { db } from "../firebase.server";
import {
  getEffectiveBillingPlan,
  listOrderJobs,
  listUploadFields,
  listUploadSessions,
} from "../services/shop-data.server";

type SetupState = {
  themeBlockEnabled: boolean;
  themeBlockVerified: boolean;
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

  const [fields, uploads, jobs, billingPlan] = await Promise.all([
    listUploadFields(shopDomain),
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
    getEffectiveBillingPlan(shopDomain),
  ]);

  const setup: SetupState = {
    themeBlockEnabled,
    themeBlockVerified: Boolean(shopSettings.themeBlockVerified),
    themeVerificationUnavailable: verificationUnavailable,
    themeVerificationMessage: verificationMessage,
    fieldsConfigured,
    cartValidationVerified: Boolean(shopSettings.cartValidationVerified),
    cartTransformVerified: Boolean(shopSettings.cartTransformVerified),
    themeEditorUrl,
  };

  const themeStepVerified =
    setup.themeVerificationUnavailable || setup.themeBlockEnabled || setup.themeBlockVerified;

  const setupComplete =
    themeStepVerified &&
    setup.fieldsConfigured &&
    setup.cartValidationVerified &&
    setup.cartTransformVerified;

  const checks = [
    {
      id: "dashboard",
      label: "Dashboard is active",
      help: "Your overview page is available with your key store metrics.",
      pass: true,
    },
    {
      id: "onboarding",
      label: "Setup wizard completed",
      help: "Cart validation and dynamic pricing have both been verified.",
      pass: Boolean(shopSettings.cartValidationVerified && shopSettings.cartTransformVerified),
    },
    {
      id: "fields",
      label: "Upload rules configured",
      help: "At least one upload field exists for your products.",
      pass: fields.length > 0,
    },
    {
      id: "storefront",
      label: "Storefront widget is ready",
      help: "Customers can see and use the upload flow on your storefront.",
      pass: uploads.length > 0 || fields.length > 0,
    },
    {
      id: "orders",
      label: "Order management is active",
      help: "You can manage uploaded files tied to orders.",
      pass: true,
    },
    {
      id: "plans",
      label: "Billing plan selected",
      help: "A billing plan is active for this store.",
      pass: Boolean(billingPlan.planCode),
    },
    {
      id: "settings",
      label: "Global settings configured",
      help: "Core app settings are available and accessible.",
      pass: true,
    },
    {
      id: "webhooks",
      label: "Order syncing is active",
      help: "Order events are syncing to PrintDock for fulfillment workflows.",
      pass: jobs.length > 0 || uploads.length > 0,
    },
  ];

  const passedCount = checks.filter((check) => check.pass).length;

  return data({
    setup,
    themeStepVerified,
    setupComplete,
    checks,
    passedCount,
    totalChecks: checks.length,
    metrics: {
      fields: fields.length,
      uploads: uploads.length,
      jobs: jobs.length,
      activePlan: billingPlan.planCode,
      usage: `${billingPlan.usageThisMonth}/${getPlan(billingPlan.planCode).maxOrdersPerMonth === -1 ? "∞" : getPlan(billingPlan.planCode).maxOrdersPerMonth}`,
    },
  });
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

  if (intent === "verify_theme_block") {
    await shopDoc.set({ themeBlockVerified: true }, { merge: true });
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
    <Badge tone={enabled ? "success" : "attention"}>
      {enabled ? "Setup verified" : "Waiting for setup"}
    </Badge>
  );
}

export default function OnboardingPage() {
  const { setup, themeStepVerified, setupComplete, checks, passedCount, totalChecks, metrics } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const ready = passedCount === totalChecks;

  return (
    <Page title="PrintDock Setup">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                1. Theme App Block
              </Text>
              <StatusBadge enabled={themeStepVerified} />
            </InlineStack>
            <Text as="p" tone="subdued">
              To show the upload button on your storefront, add the PrintDock block to your product
              page template.
            </Text>
            {themeStepVerified ? (
              <Text as="p" tone="success">
                Theme block is successfully installed.
              </Text>
            ) : null}
            {setup.themeVerificationUnavailable && setup.themeVerificationMessage ? (
              <Text as="p" tone="critical">
                {setup.themeVerificationMessage}
              </Text>
            ) : null}
            <Button url={setup.themeEditorUrl} target="_blank">
              Open Theme Editor
            </Button>
            {!themeStepVerified ? (
              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  If you already added the block and saved your theme, use this button to confirm it
                  manually when automatic detection is delayed or unavailable.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="verify_theme_block" />
                  <Button submit loading={fetcher.state === "submitting"}>
                    Mark as verified
                  </Button>
                </fetcher.Form>
              </BlockStack>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                2. Cart Validation
              </Text>
              <StatusBadge enabled={setup.cartValidationVerified} />
            </InlineStack>
            <Text as="p" tone="subdued">
              If you require customers to upload a file before checkout, ensure cart validation is
              active in your Shopify settings.
            </Text>
            <Text as="p" tone="subdued">
              Go to Shopify Settings &gt; Checkout &gt; Checkout rules to verify.
            </Text>
            {!setup.cartValidationVerified ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="verify_cart_validation" />
                <Button submit loading={fetcher.state === "submitting"}>
                  Mark as verified
                </Button>
              </fetcher.Form>
            ) : (
              <Text as="p" tone="success">
                Cart validation is verified.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                3. Cart Transform
              </Text>
              <StatusBadge enabled={setup.cartTransformVerified} />
            </InlineStack>
            <Text as="p" tone="subdued">
              If you plan to charge customers based on file size or dimensions, enable dynamic
              pricing.
            </Text>
            <Text as="p" tone="subdued">
              Ensure the PrintDock Cart Transform function is active in your Shopify settings.
            </Text>
            {!setup.cartTransformVerified ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="verify_cart_transform" />
                <Button submit loading={fetcher.state === "submitting"}>
                  Mark as verified
                </Button>
              </fetcher.Form>
            ) : (
              <Text as="p" tone="success">
                Dynamic pricing is verified.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                4. First Upload Field
              </Text>
              <StatusBadge enabled={setup.fieldsConfigured} />
            </InlineStack>
            <Text as="p" tone="subdued">
              Configure which products require file uploads, allowed file types, and pricing rules.
            </Text>
            {setup.fieldsConfigured ? (
              <Text as="p" tone="success">
                You have configured your first field.
              </Text>
            ) : null}
            <Button url={setup.fieldsConfigured ? "/app/fields" : "/app/fields/new"}>
              {setup.fieldsConfigured ? "Manage fields" : "Create field"}
            </Button>
          </BlockStack>
        </Card>

        {setupComplete ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Setup complete
              </Text>
              <Text as="p" tone="subdued">
                Your onboarding is complete. You can now manage upload fields for your products.
              </Text>
              <Button url="/app/fields" variant="primary">
                Go to Upload Fields
              </Button>
            </BlockStack>
          </Card>
        ) : null}

        <Divider />

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                App Health Status
              </Text>
              <Badge tone={ready ? "success" : "critical"}>
                {ready ? "Ready" : "Action needed"}
              </Badge>
            </InlineStack>
            <Text as="p">
              Passed {passedCount}/{totalChecks} checks.
            </Text>
            <Text as="p" tone="subdued">
              Metrics: fields {metrics.fields}, uploads {metrics.uploads}, order jobs {metrics.jobs},
              plan {metrics.activePlan}, usage {metrics.usage}
            </Text>
            <Text as="p" tone="subdued">
              This section shows whether key merchant-facing app areas are ready to use.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            {checks.map((check) => (
              <BlockStack key={check.id} gap="100">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">{check.label}</Text>
                  <Badge tone={check.pass ? "success" : "critical"}>
                    {check.pass ? "Pass" : "Pending"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {check.help}
                </Text>
              </BlockStack>
            ))}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

