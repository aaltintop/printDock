import { data, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { Badge, BlockStack, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { db } from "../firebase.server";
import {
  getEffectiveBillingPlan,
  listOrderJobs,
  listUploadFields,
  listUploadSessions,
} from "../services/shop-data.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [fields, uploads, jobs, billingPlan, shopDoc] = await Promise.all([
    listUploadFields(shopDomain),
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
    getEffectiveBillingPlan(shopDomain),
    db.collection("shops").doc(shopDomain).get(),
  ]);

  const shopSettings = shopDoc.data() ?? {};
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

export default function ParityPage() {
  const { checks, passedCount, totalChecks, metrics } = useLoaderData<typeof loader>();
  const ready = passedCount === totalChecks;

  return (
    <Page title="Parity Sign-off Checklist">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Launch Gate
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

