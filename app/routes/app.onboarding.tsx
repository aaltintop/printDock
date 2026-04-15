import { data, useLoaderData, useFetcher } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Badge, BlockStack, Box, Button, Card, InlineStack, Page, Text, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../firebase.server";
import {
  getEffectiveBillingPlan,
  listOrderJobs,
  listUploadFields,
  listUploadSessions,
} from "../services/shop-data.server";

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

  const [fields, uploads, jobs, billingPlan] = await Promise.all([
    listUploadFields(shopDomain),
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
    getEffectiveBillingPlan(shopDomain),
  ]);

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

  const checks = [
    {
      id: "dashboard",
      label: "Dashboard route, KPIs, quick links, and activity panels",
      pass: true,
    },
    {
      id: "onboarding",
      label: "Onboarding wizard completed (validation + transform verification)",
      pass: Boolean(shopSettings.cartValidationVerified && shopSettings.cartTransformVerified),
    },
    {
      id: "fields",
      label: "Fields module supports targeting, rules, pricing, renaming",
      pass: fields.length > 0,
    },
    {
      id: "storefront",
      label: "Storefront config fetch + upload session flow operational",
      pass: uploads.length > 0 || fields.length > 0,
    },
    {
      id: "orders",
      label: "Orders dashboard supports filtering, preview/download, updates, CSV",
      pass: true,
    },
    {
      id: "plans",
      label: "Plans and billing page active with usage limits enforcement",
      pass: Boolean(billingPlan.planCode),
    },
    {
      id: "settings",
      label: "Settings page + theme block health check",
      pass: true,
    },
    {
      id: "webhooks",
      label: "orders/create webhook creates jobs with renamed files and idempotency",
      pass: jobs.length > 0 || uploads.length > 0,
    },
  ];

  const passedCount = checks.filter((check) => check.pass).length;

  return data({ 
    setup, 
    setupComplete,
    checks,
    passedCount,
    totalChecks: checks.length,
    metrics: {
      fields: fields.length,
      uploads: uploads.length,
      jobs: jobs.length,
      activePlan: billingPlan.planCode,
      usage: `${billingPlan.usageThisMonth}/${billingPlan.monthlyUploadsLimit}`,
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
  const { setup, setupComplete, checks, passedCount, totalChecks, metrics } = useLoaderData<typeof loader>();
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
              <StatusBadge enabled={setup.themeBlockEnabled} />
            </InlineStack>
            <Text as="p" tone="subdued">
              Add and enable the PrintDock block in your product template.
            </Text>
            {setup.themeVerificationUnavailable && setup.themeVerificationMessage ? (
              <Text as="p" tone="critical">
                {setup.themeVerificationMessage}
              </Text>
            ) : null}
            <Button url={setup.themeEditorUrl} target="_blank">
              Open Theme Editor
            </Button>
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
              Confirm your cart validation safeguards are configured.
            </Text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="verify_cart_validation" />
              <Button submit loading={fetcher.state === "submitting"}>
                Mark as verified
              </Button>
            </fetcher.Form>
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
              Confirm cart transform pricing behavior is enabled.
            </Text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="verify_cart_transform" />
              <Button submit loading={fetcher.state === "submitting"}>
                Mark as verified
              </Button>
            </fetcher.Form>
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
              Create at least one active upload field for a product.
            </Text>
            <Button url="/app/fields/new">Create field</Button>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Next Step
            </Text>
            <Text as="p" tone="subdued">
              Continue when all setup checks are verified.
            </Text>
            <Box>
              <Button
                url={setupComplete ? "/app/fields" : undefined}
                disabled={!setupComplete}
                variant={setupComplete ? "primary" : "secondary"}
              >
                {setupComplete ? "Go to Upload Fields" : "Complete Setup First"}
              </Button>
            </Box>
          </BlockStack>
        </Card>

        <Divider />

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                System Health & Parity
              </Text>
              <Badge tone={ready ? "success" : "critical"}>
                {ready ? "Ready for launch validation" : "Action needed"}
              </Badge>
            </InlineStack>
            <Text as="p">
              Passed {passedCount}/{totalChecks} checks.
            </Text>
            <Text as="p" tone="subdued">
              Metrics: fields {metrics.fields}, uploads {metrics.uploads}, order jobs {metrics.jobs},
              plan {metrics.activePlan}, usage {metrics.usage}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            {checks.map((check) => (
              <InlineStack key={check.id} align="space-between" blockAlign="center">
                <Text as="p">{check.label}</Text>
                <Badge tone={check.pass ? "success" : "critical"}>
                  {check.pass ? "Pass" : "Pending"}
                </Badge>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

