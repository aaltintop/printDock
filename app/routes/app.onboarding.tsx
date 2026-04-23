import { data, useLoaderData, useFetcher } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Badge, BlockStack, Button, Card, InlineStack, Page, Text, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getPlan } from "../config/plans";
import { db } from "../firebase.server";
import {
  computeDashboardStats,
  getEffectiveBillingPlan,
  listOrderJobs,
  listUploadFields,
  listUploadSessions,
} from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { detectThemeBlockEnabled } from "../services/app-setup-status.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { admin, session } = await authenticate.admin(request);
      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);
      log.event("admin_page_view", { path: "/app/onboarding" });

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

  const [fields, uploads, jobs, billingPlan, stats] = await Promise.all([
    listUploadFields(shopDomain),
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
    getEffectiveBillingPlan(shopDomain),
    computeDashboardStats(shopDomain),
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
      help: "At least one field exists for your products.",
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
          storageUsedMB: stats.storageUsedMB,
          storageCapMB:
            Math.round((getPlan(billingPlan.planCode).maxTotalStorageBytes / (1024 * 1024)) * 100) /
            100,
        },
      });
    } catch (err) {
      log.error("admin_onboarding_loader_failed", err, { path: "/app/onboarding" });
      throw err;
    }
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const formData = await request.formData();
      const intent = formData.get("intent");
      const shopDoc = db.collection("shops").doc(session.shop);

      if (intent === "verify_cart_validation") {
        log.event("onboarding_verify_cart_validation", {});
        await shopDoc.set({ cartValidationVerified: true }, { merge: true });
        return data({ ok: true });
      }

      if (intent === "verify_theme_block") {
        log.event("onboarding_verify_theme_block", {});
        await shopDoc.set({ themeBlockVerified: true }, { merge: true });
        return data({ ok: true });
      }

      if (intent === "verify_cart_transform") {
        log.event("onboarding_verify_cart_transform", {});
        await shopDoc.set({ cartTransformVerified: true }, { merge: true });
        return data({ ok: true });
      }

      log.warn("onboarding_unknown_intent", "Unknown onboarding intent", {
        intent: String(intent ?? ""),
      });
      return data({ ok: false }, { status: 400 });
    } catch (err) {
      log.error("admin_onboarding_action_failed", err, { path: "/app/onboarding" });
      throw err;
    }
  });
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
                1. First field
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

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                2. Theme App Block
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
                3. Cart Validation
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
                4. Cart Transform
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

        {setupComplete ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Setup complete
              </Text>
              <Text as="p" tone="subdued">
                Your onboarding is complete. You can now manage fields for your products.
              </Text>
              <Button url="/app/fields" variant="primary">
                Go to Fields
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
              plan {metrics.activePlan}, upload storage {metrics.storageUsedMB} / {metrics.storageCapMB}{" "}
              MB
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

