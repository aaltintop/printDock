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
import {
  detectPrintDockCartTransform,
  registerPrintDockCartTransform,
  type CartTransformStatusCode,
} from "../services/cart-transform.server";

type SetupState = {
  themeBlockEnabled: boolean;
  themeBlockVerified: boolean;
  themeVerificationUnavailable: boolean;
  themeVerificationMessage: string | null;
  cartValidationVerified: boolean;
  cartTransformEnabled: boolean;
  cartTransformStatusCode: CartTransformStatusCode;
  cartTransformVerificationUnavailable: boolean;
  cartTransformVerificationMessage: string | null;
  fieldsConfigured: boolean;
  themeEditorUrl: string;
  reauthUrl: string;
};

const CART_TRANSFORM_UNAVAILABLE_CODES = new Set<CartTransformStatusCode>([
  "verification_unavailable",
  "permission_denied",
  "missing_scope",
  "not_supported",
]);

function normalizeRequestedPath(input: string | null): string | null {
  if (!input || !input.startsWith("/app")) return null;
  if (input.startsWith("/app/onboarding")) return null;
  return input;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const requestUrl = new URL(request.url);
      const { admin, session } = await authenticate.admin(request);
      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);
      log.event("admin_page_view", { path: "/app/onboarding" });
      const returnTo = normalizeRequestedPath(requestUrl.searchParams.get("returnTo"));

      const shopSettingsDoc = await db.collection("shops").doc(shopDomain).get();
      const shopSettings = shopSettingsDoc.data() ?? {};

      const [
        themeStatus,
        cartTransformStatus,
        fields,
        uploads,
        jobs,
        billingPlan,
        stats,
      ] = await Promise.all([
        detectThemeBlockEnabled(admin),
        detectPrintDockCartTransform(admin),
        listUploadFields(shopDomain),
        listUploadSessions(shopDomain),
        listOrderJobs(shopDomain),
        getEffectiveBillingPlan(shopDomain),
        computeDashboardStats(shopDomain),
      ]);

      const fieldsConfigured = fields.length > 0;
      const themeEditorUrl = themeStatus.themeId
        ? `https://${shopDomain}/admin/themes/${themeStatus.themeId.replace("gid://shopify/OnlineStoreTheme/", "")}/editor?context=apps`
        : `https://${shopDomain}/admin/themes`;

      const cartTransformVerificationUnavailable = CART_TRANSFORM_UNAVAILABLE_CODES.has(
        cartTransformStatus.code,
      );

      const reauthUrl = `/auth?shop=${encodeURIComponent(shopDomain)}`;

      const setup: SetupState = {
        themeBlockEnabled: themeStatus.enabled,
        themeBlockVerified: Boolean(shopSettings.themeBlockVerified),
        themeVerificationUnavailable: themeStatus.verificationUnavailable,
        themeVerificationMessage: themeStatus.verificationMessage,
        fieldsConfigured,
        cartValidationVerified:
          fields.some((field) => field.isRequired === true) ||
          Boolean(shopSettings.cartValidationVerified),
        cartTransformEnabled: cartTransformStatus.enabled,
        cartTransformStatusCode: cartTransformStatus.code,
        cartTransformVerificationUnavailable,
        cartTransformVerificationMessage: cartTransformStatus.message,
        themeEditorUrl,
        reauthUrl,
      };

      const themeStepVerified =
        setup.themeVerificationUnavailable || setup.themeBlockEnabled || setup.themeBlockVerified;

      // Real cart transform detection drives setup completion. We treat
      // "verification unavailable" cases (missing scope, not supported, etc.)
      // as soft passes so merchants on plans without Cart Transform are not
      // blocked from finishing onboarding.
      const cartTransformStepReady =
        setup.cartTransformEnabled || cartTransformVerificationUnavailable;

      const setupComplete =
        themeStepVerified &&
        setup.fieldsConfigured &&
        setup.cartValidationVerified &&
        cartTransformStepReady;

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
          pass: Boolean(setup.cartValidationVerified && cartTransformStepReady),
        },
        {
          id: "fields",
          label: "Upload rules configured",
          help: "At least one field exists for your products.",
          pass: fieldsConfigured,
        },
        {
          id: "storefront",
          label: "Storefront widget is ready",
          help: "Customers can see and use the upload flow on your storefront.",
          pass: uploads.length > 0 || fieldsConfigured,
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
        returnTo,
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
      if (err instanceof Response) throw err;
      log.error("admin_onboarding_loader_failed", err, { path: "/app/onboarding" });
      throw err;
    }
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { admin, session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const formData = await request.formData();
      const intent = formData.get("intent");
      const shopDoc = db.collection("shops").doc(session.shop);

      if (intent === "verify_cart_validation") {
        log.event("onboarding_verify_cart_validation", {});
        await shopDoc.set({ cartValidationVerified: true }, { merge: true });
        return data({ ok: true, intent: "verify_cart_validation" });
      }

      if (intent === "verify_theme_block") {
        log.event("onboarding_verify_theme_block", {});
        await shopDoc.set({ themeBlockVerified: true }, { merge: true });
        return data({ ok: true, intent: "verify_theme_block" });
      }

      if (intent === "register_cart_transform") {
        log.event("onboarding_register_cart_transform", {});
        const result = await registerPrintDockCartTransform(admin);
        const okStatuses: CartTransformStatusCode[] = ["active"];
        return data({
          ok: okStatuses.includes(result.code),
          intent: "register_cart_transform",
          cartTransform: {
            code: result.code,
            enabled: result.enabled,
            created: result.created,
            cartTransformId: result.cartTransformId,
            message: result.message,
          },
        });
      }

      log.warn("onboarding_unknown_intent", "Unknown onboarding intent", {
        intent: String(intent ?? ""),
      });
      return data({ ok: false }, { status: 400 });
    } catch (err) {
      if (err instanceof Response) throw err;
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

function CartTransformBadge({
  enabled,
  unavailable,
}: {
  enabled: boolean;
  unavailable: boolean;
}) {
  if (enabled) return <Badge tone="success">Registered</Badge>;
  if (unavailable) return <Badge tone="warning">Verification unavailable</Badge>;
  return <Badge tone="attention">Not registered</Badge>;
}

function CartTransformExplanation({
  code,
  message,
  enabled,
}: {
  code: CartTransformStatusCode;
  message: string | null;
  enabled: boolean;
}) {
  if (enabled) {
    return (
      <Text as="p" tone="success">
        Dynamic pricing is registered. Shopify will adjust cart line prices using the
        PrintDock function.
      </Text>
    );
  }
  switch (code) {
    case "missing":
      return (
        <Text as="p" tone="subdued">
          Cart properties are reaching Shopify, but the Cart Transform is not registered yet.
          Click &ldquo;Enable dynamic pricing&rdquo; to register it for this store.
        </Text>
      );
    case "missing_scope":
      return (
        <Text as="p" tone="critical">
          {message ??
            "PrintDock needs the `write_cart_transforms` permission. Reauthorize the app to grant it."}
        </Text>
      );
    case "function_not_deployed":
      return (
        <Text as="p" tone="critical">
          {message ??
            "The PrintDock pricing function is not deployed yet. Run `shopify app deploy` and reinstall the app."}
        </Text>
      );
    case "permission_denied":
      return (
        <Text as="p" tone="critical">
          {message ??
            "Shopify denied access to Cart Transform APIs for this store. Confirm the installer has the right permissions."}
        </Text>
      );
    case "not_supported":
      return (
        <Text as="p" tone="caution">
          {message ??
            "Dynamic price overrides require Shopify Plus on this Cart Transform operation. Static fees still work."}
        </Text>
      );
    case "verification_unavailable":
      return (
        <Text as="p" tone="caution">
          {message ??
            "Cart Transform APIs are not available for this store. Verify dynamic pricing manually in Shopify settings."}
        </Text>
      );
    case "unknown_error":
      return (
        <Text as="p" tone="critical">
          {message ??
            "Unexpected error while enabling dynamic pricing. Check the app logs and try again."}
        </Text>
      );
    default:
      return null;
  }
}

export default function OnboardingPage() {
  const { setup, themeStepVerified, setupComplete, returnTo, checks, passedCount, totalChecks, metrics } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const ready = passedCount === totalChecks;

  const cartTransformResult =
    fetcher.data && (fetcher.data as { intent?: string }).intent === "register_cart_transform"
      ? (fetcher.data as {
          ok: boolean;
          cartTransform: {
            code: CartTransformStatusCode;
            enabled: boolean;
            created: boolean;
            cartTransformId: string | null;
            message: string | null;
          };
        })
      : null;

  const liveCartTransformCode: CartTransformStatusCode =
    cartTransformResult?.cartTransform.code ?? setup.cartTransformStatusCode;
  const liveCartTransformEnabled =
    cartTransformResult?.cartTransform.enabled ?? setup.cartTransformEnabled;
  const liveCartTransformMessage =
    cartTransformResult?.cartTransform.message ?? setup.cartTransformVerificationMessage;
  const liveCartTransformUnavailable =
    cartTransformResult?.cartTransform
      ? CART_TRANSFORM_UNAVAILABLE_CODES.has(cartTransformResult.cartTransform.code)
      : setup.cartTransformVerificationUnavailable;
  const showRegisterButton =
    !liveCartTransformEnabled &&
    (liveCartTransformCode === "missing" ||
      liveCartTransformCode === "function_not_deployed" ||
      liveCartTransformCode === "unknown_error");

  return (
    <Page title="PrintDock Setup">
      <BlockStack gap="400">
        {!setupComplete && returnTo ? (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Setup required before this page
              </Text>
              <Text as="p" tone="subdued">
                You tried to open {returnTo}. Finish setup below, then continue to that page.
              </Text>
            </BlockStack>
          </Card>
        ) : null}
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
              PrintDock verifies this automatically when at least one upload field requires file
              upload before Add to Cart.
            </Text>
            <Text as="p" tone="subdued">
              You can still mark this step manually for custom storefront flows.
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
              <CartTransformBadge
                enabled={liveCartTransformEnabled}
                unavailable={liveCartTransformUnavailable}
              />
            </InlineStack>
            <Text as="p" tone="subdued">
              If you plan to charge customers based on file size or dimensions, register the
              PrintDock Cart Transform so Shopify applies the calculated price to the cart line.
            </Text>
            <CartTransformExplanation
              code={liveCartTransformCode}
              message={liveCartTransformMessage}
              enabled={liveCartTransformEnabled}
            />
            {liveCartTransformCode === "missing_scope" ? (
              <Button url={setup.reauthUrl} target="_top">
                Reauthorize PrintDock
              </Button>
            ) : null}
            {showRegisterButton ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="register_cart_transform" />
                <Button submit loading={fetcher.state === "submitting"} variant="primary">
                  Enable dynamic pricing
                </Button>
              </fetcher.Form>
            ) : null}
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

