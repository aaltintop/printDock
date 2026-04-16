import { data, redirect, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import type { PlanCode } from "../config/plans";
import {
  PLANS,
  PLAN_SUBSCRIPTION_NAMES,
  getPlan,
  planCodeFromSubscriptionName,
} from "../config/plans";
import { createSubscription } from "../services/billing.server";
import { getBillingPlan, saveBillingPlan } from "../services/shop-data.server";
import { authenticate } from "../shopify.server";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${bytes / (1024 * 1024 * 1024)}GB`;
  return `${bytes / (1024 * 1024)}MB`;
}

function derivePlanFromSubscriptions(activeSubscriptions: any[]): PlanCode {
  if (!Array.isArray(activeSubscriptions) || activeSubscriptions.length === 0) {
    return "free";
  }
  for (const sub of activeSubscriptions) {
    const resolved = planCodeFromSubscriptionName(String(sub.name ?? ""));
    if (resolved !== "free") return resolved;
  }
  return "free";
}

const PAID_PLAN_ORDER: Exclude<PlanCode, "free">[] = [
  "starter",
  "pro",
  "business",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const installationResponse = await admin.graphql(`
    #graphql
    query PrintDockPlansPage {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
        }
      }
    }
  `);
  const installationJson = await installationResponse.json();
  const activeSubscriptions =
    installationJson?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const subscriptionPlan = derivePlanFromSubscriptions(activeSubscriptions);
  const persistedPlan = await getBillingPlan(shopDomain);

  const finalPlanCode =
    subscriptionPlan === "free" ? persistedPlan.planCode : subscriptionPlan;

  await saveBillingPlan(shopDomain, {
    planCode: finalPlanCode,
    status: subscriptionPlan === "free" ? persistedPlan.status : "active",
    subscriptionId: activeSubscriptions[0]?.id ?? null,
  });

  return data({
    activePlan: finalPlanCode,
    activeSubscriptions,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const selectedPlan = String(formData.get("planCode") || "") as PlanCode;
  const shopDomain = session.shop;

  if (intent !== "select_plan") {
    return data({ error: "Unsupported action" }, { status: 400 });
  }

  if (!PLANS[selectedPlan]) {
    return data({ error: "Invalid plan selection" }, { status: 400 });
  }

  if (selectedPlan === "free") {
    await saveBillingPlan(shopDomain, {
      planCode: "free",
      status: "active",
      subscriptionId: null,
    });
    return redirect("/app/plans");
  }

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/plans?activated=${selectedPlan}`;
  const subscriptionResult = await createSubscription(
    admin,
    selectedPlan,
    returnUrl,
  );
  if (subscriptionResult.userErrors?.length) {
    return data(
      { error: subscriptionResult.userErrors[0].message },
      { status: 400 },
    );
  }

  await saveBillingPlan(shopDomain, {
    planCode: selectedPlan,
    status: "trial",
  });

  return redirect(subscriptionResult.confirmationUrl);
};

export default function PlansPage() {
  const { activePlan } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const allPlans: PlanCode[] = ["free", ...PAID_PLAN_ORDER];

  return (
    <Page title="Plans & Billing">
      <BlockStack gap="400">
        {allPlans.map((code) => {
          const plan = getPlan(code);
          const isActive = activePlan === code;
          const priceLabel =
            plan.monthlyPriceUsd === 0
              ? "$0"
              : `$${plan.monthlyPriceUsd}/mo`;

          return (
            <Card key={code}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Box>
                    <Text as="h2" variant="headingMd">
                      {plan.displayName}
                    </Text>
                    <Text as="p" variant="headingMd" tone="subdued">
                      {priceLabel}
                      {plan.yearlyPriceUsd > 0 && (
                        <Text as="span" tone="subdued">
                          {" "}
                          (${plan.yearlyPriceUsd}/yr)
                        </Text>
                      )}
                    </Text>
                  </Box>
                  <Badge tone={isActive ? "success" : "attention"}>
                    {isActive ? "Active" : "Available"}
                  </Badge>
                </InlineStack>

                <List>
                  <List.Item>
                    Max file size: {formatBytes(plan.maxFileSizeBytes)}
                  </List.Item>
                  <List.Item>
                    Orders/month:{" "}
                    {plan.maxOrdersPerMonth === -1
                      ? "Unlimited"
                      : plan.maxOrdersPerMonth}
                  </List.Item>
                  <List.Item>
                    Fields:{" "}
                    {plan.maxUploadFields === -1
                      ? "Unlimited"
                      : plan.maxUploadFields}
                  </List.Item>
                  <List.Item>
                    File retention: {plan.fileStorageDays} days
                  </List.Item>
                  <List.Item>
                    Advanced validation:{" "}
                    {plan.advancedValidation ? "Included" : "Not included"}
                  </List.Item>
                  <List.Item>
                    File renaming:{" "}
                    {plan.fileRenaming ? "Included" : "Not included"}
                  </List.Item>
                  <List.Item>
                    Bulk download:{" "}
                    {plan.bulkDownload ? "Included" : "Not included"}
                  </List.Item>
                  <List.Item>
                    Dynamic pricing:{" "}
                    {plan.dynamicPricing ? "Included" : "Not included"}
                  </List.Item>
                </List>

                <form method="post">
                  <input type="hidden" name="intent" value="select_plan" />
                  <input type="hidden" name="planCode" value={code} />
                  <Button
                    submit
                    disabled={isActive || isSubmitting}
                    variant={isActive ? "secondary" : "primary"}
                  >
                    {isActive ? "Current Plan" : "Choose Plan"}
                  </Button>
                </form>
              </BlockStack>
            </Card>
          );
        })}
      </BlockStack>
    </Page>
  );
}
