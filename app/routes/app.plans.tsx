import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
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
    <s-page heading="Plans & Billing">
      <s-stack direction="block" gap="base">
        {plans.map((plan) => (
          <s-box key={plan.code} padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <div>
                <s-heading>{plan.name}</s-heading>
                <s-paragraph>{plan.description}</s-paragraph>
              </div>
              <s-badge tone={activePlan === plan.code ? "success" : "neutral"}>
                {activePlan === plan.code ? "Active" : "Available"}
              </s-badge>
            </s-stack>

            <s-stack direction="block" gap="base">
              <s-text>{plan.monthlyPriceLabel}</s-text>
              <s-text>Monthly uploads: {plan.uploadsLimit}</s-text>
              <s-text>Max file size: {plan.fileSizeLimitMB}MB</s-text>
              <s-text>
                Advanced rules: {plan.allowAdvancedRules ? "Included" : "Not included"}
              </s-text>
              <s-text>
                Auto pricing: {plan.allowAutoPricing ? "Included" : "Not included"}
              </s-text>
            </s-stack>

            <form method="post" style={{ marginTop: 12 }}>
              <input type="hidden" name="intent" value="select_plan" />
              <input type="hidden" name="planCode" value={plan.code} />
              <s-button
                type="submit"
                disabled={activePlan === plan.code || isSubmitting}
                tone={activePlan === plan.code ? "neutral" : "critical"}
              >
                {activePlan === plan.code ? "Current Plan" : "Choose Plan"}
              </s-button>
            </form>
          </s-box>
        ))}
      </s-stack>
    </s-page>
  );
}

