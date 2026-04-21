import { useMemo, useState } from "react";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import {
  getAppAdminHandle,
  getBillingMode,
  getManagedPricingPlanSelectionUrl,
} from "../config/billing";
import type { PlanCode } from "../config/plans";
import { PLANS, getPlan, planCodeFromSubscriptionName } from "../config/plans";
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

const PLAN_ORDER: PlanCode[] = ["free", "starter", "pro", "business"];

function planTier(code: PlanCode): number {
  return PLAN_ORDER.indexOf(code);
}

/** Temporary test gate: paid upgrades only when shop domain includes this substring. */
function isTestUpgradeStore(shopDomain: string): boolean {
  return shopDomain.toLowerCase().includes("printdock");
}

function isUpgradeSelection(
  activePlan: PlanCode,
  selectedPlan: PlanCode,
): boolean {
  return planTier(selectedPlan) > planTier(activePlan);
}

const PLAN_HEADER_THEME: Record<
  PlanCode,
  { background: string; color: string }
> = {
  free: { background: "#5C6AC4", color: "#FFFFFF" },
  starter: { background: "#008060", color: "#FFFFFF" },
  pro: { background: "#F49342", color: "#FFFFFF" },
  business: { background: "#E2A317", color: "#111213" },
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(iso),
    );
  } catch {
    return "—";
  }
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
          createdAt
          currentPeriodEnd
          trialDays
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

  const pageUrl = new URL(request.url);
  const embeddedHost = pageUrl.searchParams.get("host") ?? "";
  const billingMode = getBillingMode();
  const appHandle = getAppAdminHandle();
  const managedPricingUrl = getManagedPricingPlanSelectionUrl(
    shopDomain,
    appHandle,
  );

  const testUpgradeAllowed = isTestUpgradeStore(shopDomain);

  return data({
    activePlan: finalPlanCode,
    activeSubscriptions,
    embeddedHost,
    billingMode,
    managedPricingUrl,
    testUpgradeAllowed,
  });
};

function patchEmbeddedHostFromAppBridge(form: HTMLFormElement) {
  if (typeof window === "undefined") return;
  const win = window as Window & {
    shopify?: { config?: { host?: string } };
  };
  const host = win.shopify?.config?.host;
  if (!host) return;
  const input = form.querySelector<HTMLInputElement>('input[name="host"]');
  if (input) input.value = host;
}

function embeddedPlansSearchParams(
  request: Request,
  formData: FormData,
  shopDomain: string,
  extra: Record<string, string>,
): URLSearchParams {
  const pageUrl = new URL(request.url);
  const host =
    String(formData.get("host") || "").trim() ||
    pageUrl.searchParams.get("host") ||
    "";
  const params = new URLSearchParams();
  params.set("shop", shopDomain);
  if (host) params.set("host", host);
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, value);
  }
  return params;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (getBillingMode() !== "api") {
    return data(
      {
        error:
          "This app uses Shopify managed pricing. Open the plan selection page using the buttons on this screen.",
      },
      { status: 400 },
    );
  }

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
    const query = embeddedPlansSearchParams(request, formData, shopDomain, {});
    return redirect(`/app/plans?${query.toString()}`);
  }

  const persistedForAction = await getBillingPlan(shopDomain);
  const installationForAction = await admin.graphql(`
    #graphql
    query PrintDockPlansAction {
      currentAppInstallation {
        activeSubscriptions {
          name
        }
      }
    }
  `);
  const installationJsonForAction = await installationForAction.json();
  const subsForAction =
    installationJsonForAction?.data?.currentAppInstallation
      ?.activeSubscriptions ?? [];
  const subscriptionPlanForAction =
    derivePlanFromSubscriptions(subsForAction);
  const activePlanForAction: PlanCode =
    subscriptionPlanForAction === "free"
      ? persistedForAction.planCode
      : subscriptionPlanForAction;

  if (
    isUpgradeSelection(activePlanForAction, selectedPlan) &&
    !isTestUpgradeStore(shopDomain)
  ) {
    return data(
      {
        error:
          "Test mode: plan upgrades are only available for development stores whose shop name includes “printdock”.",
      },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const returnParams = embeddedPlansSearchParams(request, formData, shopDomain, {
    activated: selectedPlan,
  });
  const returnUrl = `${url.origin}/app/plans?${returnParams.toString()}`;
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

function planActionLabel(
  code: PlanCode,
  activePlan: PlanCode,
): "current" | "upgrade" | "downgrade" | "choose" {
  if (code === activePlan) return "current";
  const d = planTier(code) - planTier(activePlan);
  if (d > 0) return "upgrade";
  if (d < 0) return "downgrade";
  return "choose";
}

function priceLine(
  plan: ReturnType<typeof getPlan>,
  interval: "monthly" | "annual",
): { main: string; sub?: string } {
  if (plan.monthlyPriceUsd === 0) {
    return { main: "$0" };
  }
  if (interval === "monthly") {
    return { main: `$${plan.monthlyPriceUsd}/mo` };
  }
  const y = plan.yearlyPriceUsd;
  const perMo = Math.round(y / 12);
  return {
    main: `$${perMo}/mo`,
    sub: `$${y}/yr billed annually`,
  };
}

function annualSavingsMonths(plan: ReturnType<typeof getPlan>): number {
  if (plan.monthlyPriceUsd <= 0 || plan.yearlyPriceUsd <= 0) return 0;
  const saved = plan.monthlyPriceUsd * 12 - plan.yearlyPriceUsd;
  return Math.max(0, Math.round(saved / plan.monthlyPriceUsd));
}

function trialSummary(
  sub: {
    status: string;
    createdAt: string | null;
    trialDays: number;
  } | null,
): string {
  if (!sub || sub.trialDays <= 0) return "—";
  const created = sub.createdAt ? new Date(sub.createdAt).getTime() : NaN;
  if (Number.isNaN(created)) return "—";
  const end = created + sub.trialDays * 86_400_000;
  if (Date.now() >= end) return "Trial ended";
  const daysLeft = Math.ceil((end - Date.now()) / 86_400_000);
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

export default function PlansPage() {
  const {
    activePlan,
    embeddedHost,
    billingMode,
    managedPricingUrl,
    activeSubscriptions,
    testUpgradeAllowed,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">(
    "monthly",
  );

  const allPlans: PlanCode[] = ["free", ...PAID_PLAN_ORDER];

  const primarySubscription = useMemo(() => {
    const list = activeSubscriptions as Array<{
      id: string;
      name: string;
      status: string;
      createdAt?: string | null;
      currentPeriodEnd?: string | null;
      trialDays?: number;
    }>;
    if (!Array.isArray(list) || list.length === 0) return null;
    const match = list.find(
      (s) => planCodeFromSubscriptionName(String(s.name ?? "")) === activePlan,
    );
    return match ?? list[0];
  }, [activeSubscriptions, activePlan]);

  const annualToggleHelp = useMemo(() => {
    const paid = PAID_PLAN_ORDER.map((c) => getPlan(c));
    const maxSave = Math.max(...paid.map((p) => annualSavingsMonths(p)));
    return maxSave > 0
      ? `Annual (save ~${maxSave} mo vs monthly)`
      : "Annual";
  }, []);

  return (
    <Page title="Plans">
      <BlockStack gap="500">
        {actionData && "error" in actionData && actionData.error ? (
          <Banner tone="critical" title="Could not update plan">
            <p>{String(actionData.error)}</p>
          </Banner>
        ) : null}

        {billingMode === "managed" ? (
          <Banner tone="info">
            <p>
              Subscriptions are purchased on Shopify&apos;s plan page. Use the actions below;
              ensure Partner Dashboard plan names match{" "}
              <Text as="span" fontWeight="semibold">
                PrintDock Starter / Pro / Business
              </Text>{" "}
              so limits sync correctly.
            </p>
          </Banner>
        ) : null}

        {!testUpgradeAllowed ? (
          <Banner tone="warning" title="Test: upgrades restricted">
            <p>
              Plan upgrades are temporarily limited to shops whose domain includes{" "}
              <Text as="span" fontWeight="semibold">
                printdock
              </Text>
              . Downgrades and the free plan still work.
            </p>
          </Banner>
        ) : null}

        <InlineStack align="space-between" blockAlign="center" wrap>
          <BlockStack gap="100">
            <Text as="h1" variant="headingLg">
              Compare plans
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              File retention applies to stored uploads; removed files cannot be recovered.
            </Text>
          </BlockStack>
          <ButtonGroup variant="segmented">
            <Button
              pressed={billingInterval === "monthly"}
              onClick={() => setBillingInterval("monthly")}
            >
              Monthly
            </Button>
            <Button
              pressed={billingInterval === "annual"}
              onClick={() => setBillingInterval("annual")}
            >
              {annualToggleHelp}
            </Button>
          </ButtonGroup>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          {allPlans.map((code) => {
            const plan = getPlan(code);
            const isActive = activePlan === code;
            const action = planActionLabel(code, activePlan);
            const theme = PLAN_HEADER_THEME[code];
            const { main, sub } = priceLine(
              plan,
              billingInterval === "annual" ? "annual" : "monthly",
            );

            const buttonLabel =
              action === "current"
                ? "Current plan"
                : action === "upgrade"
                  ? "Upgrade"
                  : action === "downgrade"
                    ? "Downgrade"
                    : "Choose plan";

            const buttonVariant =
              action === "current"
                ? "secondary"
                : action === "downgrade"
                  ? "secondary"
                  : "primary";

            const upgradeBlocked =
              action === "upgrade" && !testUpgradeAllowed;

            return (
              <Card key={code} padding="0">
                <BlockStack gap="0">
                  <div
                    style={{
                      background: theme.background,
                      color: theme.color,
                      padding: "var(--p-space-300) var(--p-space-400)",
                    }}
                  >
                    <Text
                      as="h2"
                      variant="headingMd"
                      fontWeight="bold"
                    >
                      <span style={{ color: theme.color }}>
                        {plan.displayName.toUpperCase()}
                      </span>
                    </Text>
                  </div>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <BlockStack gap="100">
                        <Text as="p" variant="headingLg">
                          {main}
                        </Text>
                        {sub ? (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {sub}
                          </Text>
                        ) : null}
                      </BlockStack>
                      <Divider />
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
                          Upload fields:{" "}
                          {plan.maxUploadFields === -1
                            ? "Unlimited"
                            : plan.maxUploadFields}
                        </List.Item>
                        <List.Item>
                          File retention: {plan.fileStorageDays} days
                        </List.Item>
                        <List.Item>
                          Advanced validation:{" "}
                          {plan.advancedValidation ? "Yes" : "—"}
                        </List.Item>
                        <List.Item>
                          File renaming: {plan.fileRenaming ? "Yes" : "—"}
                        </List.Item>
                        <List.Item>
                          Bulk download: {plan.bulkDownload ? "Yes" : "—"}
                        </List.Item>
                        <List.Item>
                          Dynamic pricing: {plan.dynamicPricing ? "Yes" : "—"}
                        </List.Item>
                      </List>

                      {billingMode === "managed" ? (
                        <Button
                          url={upgradeBlocked ? undefined : managedPricingUrl}
                          target="_top"
                          disabled={isActive || upgradeBlocked}
                          variant={buttonVariant}
                          fullWidth
                        >
                          {buttonLabel}
                        </Button>
                      ) : (
                        <Form
                          method="post"
                          onSubmit={(e) =>
                            patchEmbeddedHostFromAppBridge(e.currentTarget)
                          }
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="select_plan"
                          />
                          <input type="hidden" name="planCode" value={code} />
                          <input type="hidden" name="host" value={embeddedHost} />
                          <Button
                            submit
                            disabled={
                              isActive || isSubmitting || upgradeBlocked
                            }
                            variant={buttonVariant}
                            fullWidth
                          >
                            {buttonLabel}
                          </Button>
                        </Form>
                      )}
                    </BlockStack>
                  </Box>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>

        {primarySubscription ? (
          <Card>
            <InlineStack
              gap="600"
              align="space-between"
              blockAlign="start"
              wrap
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Currently active plan
                </Text>
                <Badge tone="attention">
                  {getPlan(activePlan).displayName.toUpperCase()}
                </Badge>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Subscription started on
                </Text>
                <Text variant="bodyMd" as="span">
                  {formatDate(primarySubscription.createdAt ?? null)}
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Free trial
                </Text>
                <Text variant="bodyMd" as="span">
                  {trialSummary({
                    status: String(primarySubscription.status ?? ""),
                    createdAt: primarySubscription.createdAt ?? null,
                    trialDays: Number(primarySubscription.trialDays ?? 0),
                  })}
                </Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Next billing date
                </Text>
                <Text variant="bodyMd" as="span">
                  {formatDate(primarySubscription.currentPeriodEnd ?? null)}
                </Text>
              </BlockStack>
            </InlineStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Get early access to new features
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              We&apos;re building more tools for upload workflows. Coming soon:
            </Text>
            <List>
              <List.Item>Richer file manager with bulk download and filters</List.Item>
              <List.Item>More validation rules and presets</List.Item>
              <List.Item>Additional order and fulfillment integrations</List.Item>
              <List.Item>And more…</List.Item>
            </List>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
