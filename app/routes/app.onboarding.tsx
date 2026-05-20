import { data, useLoaderData, useFetcher } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, List, Page, Text, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getPlan } from "../config/plans";
import { getDynamicPricingPlanMismatch } from "../utils/dynamic-pricing-plan";
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
  detectCartTransformConflict,
  detectPrintDockCartTransform,
  registerPrintDockCartTransform,
  type CartTransformStatusCode,
} from "../services/cart-transform.server";
import {
  detectPrintDockCartValidation,
  registerPrintDockCartValidation,
} from "../services/cart-validation.server";
import { ensureHmacSecret, getHmacSecretFromFirestore } from "../services/shop-secret.server";

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
  cartTransformConflictMessage: string | null;
  fieldsConfigured: boolean;
  pricingSecretConfigured: boolean;
  themeEditorUrl: string;
  reauthUrl: string;
};

const CART_TRANSFORM_UNAVAILABLE_CODES = new Set<CartTransformStatusCode>([
  "verification_unavailable",
  "permission_denied",
  "missing_scope",
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
        cartTransformConflict,
        fields,
        uploads,
        jobs,
        billingPlan,
        stats,
        pricingSecret,
      ] = await Promise.all([
        detectThemeBlockEnabled(admin),
        detectPrintDockCartTransform(admin),
        detectCartTransformConflict(admin),
        listUploadFields(shopDomain),
        listUploadSessions(shopDomain),
        listOrderJobs(shopDomain),
        getEffectiveBillingPlan(shopDomain),
        computeDashboardStats(shopDomain),
        getHmacSecretFromFirestore(shopDomain),
      ]);

      const fieldsConfigured = fields.length > 0;
      const themeEditorUrl = themeStatus.themeId
        ? `https://${shopDomain}/admin/themes/${themeStatus.themeId.replace("gid://shopify/OnlineStoreTheme/", "")}/editor?context=apps`
        : `https://${shopDomain}/admin/themes`;

      const cartTransformVerificationUnavailable = CART_TRANSFORM_UNAVAILABLE_CODES.has(
        cartTransformStatus.code,
      );

      const reauthUrl = `/auth?shop=${encodeURIComponent(shopDomain)}`;

      const pricingSecretConfigured = Boolean(pricingSecret);
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
        cartTransformConflictMessage: cartTransformConflict.message,
        themeEditorUrl,
        reauthUrl,
        pricingSecretConfigured,
      };

      const themeStepVerified =
        setup.themeVerificationUnavailable || setup.themeBlockEnabled || setup.themeBlockVerified;

      const cartTransformStepReady = setup.cartTransformEnabled && !setup.cartTransformConflictMessage;

      const setupComplete =
        themeStepVerified &&
        setup.fieldsConfigured &&
        setup.cartValidationVerified &&
        cartTransformStepReady &&
        setup.pricingSecretConfigured;

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
          pass: Boolean(
            setup.cartValidationVerified && cartTransformStepReady && setup.pricingSecretConfigured,
          ),
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

      const dynamicPricingPlanMismatch = getDynamicPricingPlanMismatch(
        fields,
        billingPlan.planCode,
      );

      const checksWithPlanGates = [
        ...checks,
        {
          id: "dynamic_pricing_plan",
          label: "Dynamic pricing matches your plan",
          help: "No upload field has dynamic pricing enabled while your plan does not support it.",
          pass: !dynamicPricingPlanMismatch,
        },
      ];
      const passedCountWithPlanGates = checksWithPlanGates.filter((check) => check.pass).length;

      return data({
        setup,
        themeStepVerified,
        setupComplete,
        returnTo,
        dynamicPricingPlanMismatch,
        checks: checksWithPlanGates,
        passedCount: passedCountWithPlanGates,
        totalChecks: checksWithPlanGates.length,
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
        const conflict = await detectCartTransformConflict(admin);
        if (conflict.hasConflict) {
          return data({
            ok: false,
            intent: "register_cart_transform",
            pricingSecretConfigured: false,
            cartTransform: {
              code: "unknown_error" as CartTransformStatusCode,
              enabled: false,
              created: false,
              cartTransformId: null,
              message: conflict.message,
            },
          });
        }
        try {
          await ensureHmacSecret(admin, session.shop);
        } catch (error) {
          const rawMessage = String((error as { message?: string })?.message || error || "");
          const friendlyMessage = /^could not mirror hmac secret/i.test(rawMessage)
            ? rawMessage
            : /^could not (create|configure) upload fee/i.test(rawMessage)
              ? rawMessage
              : `Could not set up upload pricing: ${rawMessage}`;
          log.error("onboarding_hmac_setup_failed", error, { shopDomain: session.shop });
          return data({
            ok: false,
            intent: "register_cart_transform",
            pricingSecretConfigured: false,
            cartTransform: {
              code: "unknown_error" as CartTransformStatusCode,
              enabled: false,
              created: false,
              cartTransformId: null,
              message: friendlyMessage,
            },
          });
        }
        const result = await registerPrintDockCartTransform(admin, session.shop);
        await registerPrintDockCartValidation(admin);
        const pricingSecretConfigured = Boolean(await getHmacSecretFromFirestore(session.shop));
        const okStatuses: CartTransformStatusCode[] = ["active"];
        return data({
          ok: okStatuses.includes(result.code),
          intent: "register_cart_transform",
          pricingSecretConfigured,
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
          Click &ldquo;Set up upload pricing&rdquo; to register it for this store.
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
  const {
    setup,
    themeStepVerified,
    setupComplete,
    checks,
    passedCount,
    totalChecks,
    metrics,
    dynamicPricingPlanMismatch,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const ready = passedCount === totalChecks;

  const cartTransformIntents = new Set(["register_cart_transform"]);
  const cartTransformResult =
    fetcher.data &&
      cartTransformIntents.has(String((fetcher.data as { intent?: string }).intent || ""))
      ? (fetcher.data as {
        ok: boolean;
        pricingSecretConfigured?: boolean;
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
  const livePricingSecretConfigured =
    cartTransformResult &&
      typeof cartTransformResult.pricingSecretConfigured === "boolean"
      ? cartTransformResult.pricingSecretConfigured
      : setup.pricingSecretConfigured;
  const needsReauthForScopes =
    liveCartTransformCode === "missing_scope" ||
    (liveCartTransformCode === "unknown_error" &&
      (() => {
        const lower = String(liveCartTransformMessage || "").toLowerCase();
        return (
          lower.includes("write_cart_transforms") ||
          lower.includes("write_products") ||
          lower.includes("write_publications") ||
          lower.includes("read_publications") ||
          lower.includes("metafield")
        );
      })());
  const showRegisterButton =
    !setup.cartTransformConflictMessage &&
    (!liveCartTransformEnabled || !livePricingSecretConfigured) &&
    (liveCartTransformCode === "missing" ||
      liveCartTransformCode === "function_not_deployed" ||
      liveCartTransformCode === "unknown_error" ||
      liveCartTransformCode === "active");

  const mismatchFieldPreview = dynamicPricingPlanMismatch?.fields.slice(0, 5) ?? [];
  const mismatchFieldOverflow =
    (dynamicPricingPlanMismatch?.fields.length ?? 0) - mismatchFieldPreview.length;

  return (
    <Page title="PrintDock Setup">
      <BlockStack gap="400">
        {dynamicPricingPlanMismatch ? (
          <Banner
            tone="warning"
            title="Dynamic pricing is on for at least one field, but your plan does not include it"
          >
            <BlockStack gap="300">
              <Text as="p">
                Your current plan ({getPlan(dynamicPricingPlanMismatch.planCode).displayName}) does
                not apply upload fees at checkout. Customers may only pay the base product price
                even though dynamic pricing is still enabled on{" "}
                {dynamicPricingPlanMismatch.fields.length === 1
                  ? "one field"
                  : `${dynamicPricingPlanMismatch.fields.length} fields`}
                . This often happens after a plan downgrade or when a field was copied from another
                store.
              </Text>
              <List type="bullet">
                {mismatchFieldPreview.map((field) => (
                  <List.Item key={field.id}>{field.adminTitle}</List.Item>
                ))}
              </List>
              {mismatchFieldOverflow > 0 ? (
                <Text as="p" tone="subdued">
                  And {mismatchFieldOverflow} more field
                  {mismatchFieldOverflow === 1 ? "" : "s"}.
                </Text>
              ) : null}
              <Text as="p" tone="subdued">
                Fix: upgrade to {dynamicPricingPlanMismatch.upgradePlanName}, or open each field,
                turn off &ldquo;Charge using dynamic pricing&rdquo;, and save.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/plans" variant="primary">
                  View plans
                </Button>
                <Button url="/app/fields">Manage fields</Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                1. Create your first field
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
              Registers PrintDock Cart Transform, cart validation (fee-line guard), and stores a shop
              signing key so checkout can apply your upload fee securely.
            </Text>
            {setup.cartTransformConflictMessage ? (
              <Text as="p" tone="critical">
                {setup.cartTransformConflictMessage}
              </Text>
            ) : null}
            <CartTransformExplanation
              code={liveCartTransformCode}
              message={liveCartTransformMessage}
              enabled={liveCartTransformEnabled}
            />
            {needsReauthForScopes ? (
              <Button url={setup.reauthUrl} target="_top">
                Reauthorize PrintDock
              </Button>
            ) : null}
            {showRegisterButton ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="register_cart_transform" />
                <Button submit loading={fetcher.state === "submitting"} variant="primary">
                  Set up upload pricing
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

