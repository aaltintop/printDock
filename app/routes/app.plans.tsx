import { data, redirect, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { createSubscription } from "../services/billing.server";
import { getBillingPlan, saveBillingPlan } from "../services/shop-data.server";
import { authenticate } from "../shopify.server";

type PlanCode = "free" | "basic_plus" | "pro_plus";

const PLAN_DEFINITIONS: Record<
  PlanCode,
  {
    code: PlanCode;
    name: string;
    monthlyPriceLabel: string;
    uploadsLimit: number;
    fileSizeLimitMB: number;
    allowAdvancedRules: boolean;
    allowAutoPricing: boolean;
    description: string;
  }
> = {
  free: {
    code: "free",
    name: "Free",
    monthlyPriceLabel: "$0",
    uploadsLimit: 100,
    fileSizeLimitMB: 50,
    allowAdvancedRules: false,
    allowAutoPricing: false,
    description: "Starter tier for testing upload workflows.",
  },
  basic_plus: {
    code: "basic_plus",
    name: "Basic Plus",
    monthlyPriceLabel: "$19/mo",
    uploadsLimit: 2000,
    fileSizeLimitMB: 200,
    allowAdvancedRules: true,
    allowAutoPricing: true,
    description: "Best for merchants needing dynamic pricing and rules.",
  },
  pro_plus: {
    code: "pro_plus",
    name: "Pro Plus",
    monthlyPriceLabel: "$49/mo",
    uploadsLimit: 10000,
    fileSizeLimitMB: 500,
    allowAdvancedRules: true,
    allowAutoPricing: true,
    description: "High-volume tier with larger limits and priority operations.",
  },
};

function derivePlanFromSubscriptions(activeSubscriptions: any[]): PlanCode {
  if (!Array.isArray(activeSubscriptions) || activeSubscriptions.length === 0) {
    return "free";
  }
  const names = activeSubscriptions.map((sub) => String(sub.name || "").toLowerCase());
  if (names.some((name) => name.includes("pro plus"))) return "pro_plus";
  if (names.some((name) => name.includes("basic plus"))) return "basic_plus";
  return "free";
}

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

  const finalPlanCode = subscriptionPlan === "free" ? persistedPlan.planCode : subscriptionPlan;
  const planDefinition = PLAN_DEFINITIONS[finalPlanCode] ?? PLAN_DEFINITIONS.free;
  await saveBillingPlan(shopDomain, {
    planCode: finalPlanCode,
    status: subscriptionPlan === "free" ? persistedPlan.status : "active",
    subscriptionId: activeSubscriptions[0]?.id ?? null,
    monthlyUploadsLimit: planDefinition.uploadsLimit,
    maxFileMBLimit: planDefinition.fileSizeLimitMB,
    allowAdvancedRules: planDefinition.allowAdvancedRules,
    allowAutoPricing: planDefinition.allowAutoPricing,
  });

  return data({
    plans: Object.values(PLAN_DEFINITIONS),
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

  if (!PLAN_DEFINITIONS[selectedPlan]) {
    return data({ error: "Invalid plan selection" }, { status: 400 });
  }

  if (selectedPlan === "free") {
    const freePlan = PLAN_DEFINITIONS.free;
    await saveBillingPlan(shopDomain, {
      planCode: "free",
      status: "active",
      subscriptionId: null,
      monthlyUploadsLimit: freePlan.uploadsLimit,
      maxFileMBLimit: freePlan.fileSizeLimitMB,
      allowAdvancedRules: freePlan.allowAdvancedRules,
      allowAutoPricing: freePlan.allowAutoPricing,
    });
    return redirect("/app/plans");
  }

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/app/plans?activated=${selectedPlan}`;
  const subscriptionResult = await createSubscription(admin, selectedPlan, returnUrl);
  if (subscriptionResult.userErrors?.length) {
    return data({ error: subscriptionResult.userErrors[0].message }, { status: 400 });
  }

  const selectedPlanDef = PLAN_DEFINITIONS[selectedPlan];
  await saveBillingPlan(shopDomain, {
    planCode: selectedPlan,
    status: "trial",
    monthlyUploadsLimit: selectedPlanDef.uploadsLimit,
    maxFileMBLimit: selectedPlanDef.fileSizeLimitMB,
    allowAdvancedRules: selectedPlanDef.allowAdvancedRules,
    allowAutoPricing: selectedPlanDef.allowAutoPricing,
  });

  return redirect(subscriptionResult.confirmationUrl);
};

export default function PlansPage() {
  const { plans, activePlan } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Page title="Plans & Billing">
      <BlockStack gap="400">
        {plans.map((plan) => (
          <Card key={plan.code}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Box>
                  <Text as="h2" variant="headingMd">
                    {plan.name}
                  </Text>
                  <Text as="p" tone="subdued">
                    {plan.description}
                  </Text>
                </Box>
                <Badge tone={activePlan === plan.code ? "success" : "attention"}>
                  {activePlan === plan.code ? "Active" : "Available"}
                </Badge>
              </InlineStack>

              <BlockStack gap="100">
                <Text as="p" variant="headingMd">
                  {plan.monthlyPriceLabel}
                </Text>
                <Text as="p">Monthly uploads: {plan.uploadsLimit}</Text>
                <Text as="p">Max file size: {plan.fileSizeLimitMB}MB</Text>
                <Text as="p">
                  Advanced rules: {plan.allowAdvancedRules ? "Included" : "Not included"}
                </Text>
                <Text as="p">
                  Auto pricing: {plan.allowAutoPricing ? "Included" : "Not included"}
                </Text>
              </BlockStack>

              <form method="post">
                <input type="hidden" name="intent" value="select_plan" />
                <input type="hidden" name="planCode" value={plan.code} />
                <Button
                  submit
                  disabled={activePlan === plan.code || isSubmitting}
                  variant={activePlan === plan.code ? "secondary" : "primary"}
                >
                  {activePlan === plan.code ? "Current Plan" : "Choose Plan"}
                </Button>
              </form>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}

