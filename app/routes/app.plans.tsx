import { data, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  Badge,
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
import { getEffectiveBillingPlan } from "../services/shop-data.server";
import { authenticate } from "../shopify.server";
import {
  log,
  runWithRequestContext,
  setLogShopDomain,
} from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const billingPlan = await getEffectiveBillingPlan(session.shop);
    const plan = getPlan(billingPlan.planCode);
    const managedPricingUrl = getManagedPricingPlanSelectionUrl(
      session.shop,
      getAppAdminHandle(),
    );
    log.event("plans_page_view", {
      currentPlanCode: billingPlan.planCode,
      billingStatus: billingPlan.status,
      url: managedPricingUrl,
    });
    return data({
      managedPricingUrl,
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
  const { managedPricingUrl, currentPlan } = useLoaderData<typeof loader>();
  const planStatusTone =
    currentPlan.planCode === "free"
      ? "success"
      : currentPlan.status === "active"
      ? "success"
      : currentPlan.status === "trial"
        ? "attention"
        : "critical";
  const planStatusLabel =
    currentPlan.planCode === "free"
      ? "Free"
      : currentPlan.status;

  return (
    <Page title="Plans">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Current plan
              </Text>
              <Badge tone={planStatusTone}>{planStatusLabel}</Badge>
            </InlineStack>
            <Text as="p" variant="headingLg">
              {currentPlan.displayName}
            </Text>
            <Divider />
            <Text as="p" tone="subdued">
              Upload fields:{" "}
              {currentPlan.maxUploadFields === -1 ? "Unlimited" : currentPlan.maxUploadFields}
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
