import { useEffect, useRef } from "react";
import { data, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Link,
  Page,
  Text,
} from "@shopify/polaris";

import {
  getAppAdminHandle,
  getManagedPricingPlanSelectionUrl,
} from "../config/billing";
import { getPlan } from "../config/plans";
import {
  hasActiveSubscription,
  shouldEnforceBillingGate,
} from "../services/billing-gate.server";
import { getEffectiveBillingPlan } from "../services/shop-data.server";
import { isPartnerDevelopmentStore } from "../services/shop-plan.server";
import { authenticate } from "../shopify.server";
import {
  log,
  runWithRequestContext,
  setLogShopDomain,
} from "../lib/logger.server";

/** Prevents bounce loops if the merchant returns from Shopify without selecting a plan. */
const PRICING_AUTO_REDIRECT_KEY = "printdock_pricing_plans_auto_redirect";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { admin, session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const billingPlan = await getEffectiveBillingPlan(session.shop);
    const plan = getPlan(billingPlan.planCode);
    const managedPricingUrl = getManagedPricingPlanSelectionUrl(
      session.shop,
      getAppAdminHandle(),
    );
    const isDevStore = await isPartnerDevelopmentStore(admin);
    const url = new URL(request.url);
    const billingLockedParam = url.searchParams.get("billingLocked") === "1";
    const billingLocked =
      billingLockedParam || shouldEnforceBillingGate(billingPlan);
    const hasSubscription = hasActiveSubscription(billingPlan);
    // Gate-locked first visits (and any locked visit with no plan) should jump
    // straight to Shopify Managed Pricing. Client skips repeats via sessionStorage.
    const autoRedirectToShopify = billingLocked && !hasSubscription;
    log.event("plans_page_view", {
      currentPlanCode: billingPlan.planCode,
      billingStatus: billingPlan.status,
      billingLocked,
      isDevStore,
      autoRedirectToShopify,
      url: managedPricingUrl,
    });
    if (autoRedirectToShopify) {
      log.event("plans_redirect_to_shopify", { url: managedPricingUrl });
    }
    return data({
      managedPricingUrl,
      isDevStore,
      billingLocked,
      hasSubscription,
      autoRedirectToShopify,
      currentPlan: {
        planCode: billingPlan.planCode,
        displayName: plan.displayName,
        status: billingPlan.status,
        maxUploadFields: plan.maxUploadFields,
        maxFileSizeMB: Math.round(plan.maxFileSizeBytes / (1024 * 1024)),
        maxTotalStorageGB:
          Math.round((plan.maxTotalStorageBytes / (1024 * 1024 * 1024)) * 100) / 100,
        fileStorageDays: plan.fileStorageDays,
      },
    });
  });
};

export default function PlansPage() {
  const {
    managedPricingUrl,
    isDevStore,
    billingLocked,
    hasSubscription,
    autoRedirectToShopify,
    currentPlan,
  } = useLoaderData<typeof loader>();
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (hasSubscription) {
      try {
        sessionStorage.removeItem(PRICING_AUTO_REDIRECT_KEY);
      } catch {
        // ignore storage failures
      }
    }
  }, [hasSubscription]);

  useEffect(() => {
    if (!autoRedirectToShopify || redirectedRef.current) return;
    try {
      if (sessionStorage.getItem(PRICING_AUTO_REDIRECT_KEY) === managedPricingUrl) {
        return;
      }
      sessionStorage.setItem(PRICING_AUTO_REDIRECT_KEY, managedPricingUrl);
    } catch {
      // Still attempt a one-shot redirect this mount if storage is unavailable.
    }
    redirectedRef.current = true;
    const topWin = window.top ?? window;
    topWin.location.href = managedPricingUrl;
  }, [autoRedirectToShopify, managedPricingUrl]);

  const planStatusTone =
    !hasSubscription
      ? "critical"
      : currentPlan.planCode === "free"
        ? "success"
        : currentPlan.status === "active"
          ? "success"
          : currentPlan.status === "trial"
            ? "attention"
            : "critical";
  const planStatusLabel = !hasSubscription
    ? "No plan selected"
    : currentPlan.planCode === "free"
      ? "Free"
      : currentPlan.status;

  return (
    <Page title="Plans">
      <BlockStack gap="400">
        {billingLocked ? (
          <Banner
            tone="warning"
            title={
              autoRedirectToShopify
                ? "Taking you to Shopify plan selection"
                : "Select a plan to use PrintDock"
            }
          >
            <p>
              {autoRedirectToShopify
                ? "Every store needs an active PrintDock plan — including the Free plan. If Shopify plan selection does not open automatically, use the button below. The rest of the app stays locked until a plan is active. Your storefront upload widget keeps working under Free limits for customers."
                : "Every store needs an active PrintDock plan — including the Free plan. Open Shopify plan selection, choose a plan, then return here. The rest of the app stays locked until a plan is active. Your storefront upload widget keeps working under Free limits for customers."}
            </p>
          </Banner>
        ) : null}

        {isDevStore ? (
          <Banner tone="info" title="Development store billing">
            <p>
              Development stores cannot approve paid public plans. To test paid tiers, subscribe to
              a <strong>$0 private test plan</strong> allowlisted for this store in the Partner
              Dashboard (Pricing → Private plans). Plan names must match Free, Starter, Pro, or
              Business.
            </p>
            <p>
              For feature testing without the billing round-trip, use{" "}
              <code>scripts/set-dev-billing-plan.mjs</code> (allowlisted dev shops only). See{" "}
              <code>docs/DEV_STORE_BILLING_TESTING.md</code>.
            </p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Current plan
              </Text>
              <Badge tone={planStatusTone}>{planStatusLabel}</Badge>
            </InlineStack>
            <Text as="p" variant="headingLg">
              {hasSubscription ? currentPlan.displayName : "None"}
            </Text>
            <Divider />
            {hasSubscription ? (
              <>
                <Text as="p" tone="subdued">
                  Upload fields:{" "}
                  {currentPlan.maxUploadFields === -1
                    ? "Unlimited"
                    : currentPlan.maxUploadFields}
                </Text>
                <Text as="p" tone="subdued">
                  Max file size: {currentPlan.maxFileSizeMB} MB
                </Text>
                <Text as="p" tone="subdued">
                  Total storage cap: {currentPlan.maxTotalStorageGB} GB
                </Text>
                <Text as="p" tone="subdued">
                  File retention: {currentPlan.fileStorageDays} days
                </Text>
              </>
            ) : (
              <Text as="p" tone="subdued">
                Choose Free or a paid plan in Shopify to unlock the PrintDock admin.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Manage billing in Shopify
            </Text>
            <Text as="p" tone="subdued">
              Plan changes are managed by Shopify. Continue to Shopify to compare plans, upgrade, or
              review billing details.
            </Text>
            <InlineStack gap="200">
              <Button url={managedPricingUrl} target="_top" variant="primary">
                Open plan selection in Shopify
              </Button>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              If the button does not open,{" "}
              <Link url={managedPricingUrl} target="_top">
                open plan selection directly
              </Link>
              .
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
