import { data, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  SkeletonPage,
  Text,
} from "@shopify/polaris";
import { getPlan } from "../config/plans";
import {
  computeDashboardStats,
  getEffectiveBillingPlan,
  listOrderJobs,
  listUploadSessions,
} from "../services/shop-data.server";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);
      log.event("admin_page_view", { path: "/app" });

      const [stats, sessions, jobs, billingPlan] = await Promise.all([
        computeDashboardStats(shopDomain),
        listUploadSessions(shopDomain),
        listOrderJobs(shopDomain),
        getEffectiveBillingPlan(shopDomain),
      ]);

      const planLimits = getPlan(billingPlan.planCode);
      const ordersCap = planLimits.maxOrdersPerMonth;
      const ordersUsageLabel =
        ordersCap === -1
          ? `${billingPlan.usageThisMonth} billable orders this month`
          : `${billingPlan.usageThisMonth} / ${ordersCap} billable orders this month`;

  const recentUploads = sessions
    .flatMap((uploadSession) => {
      const assets = uploadSession.assets.length > 0 ? uploadSession.assets : uploadSession.asset ? [uploadSession.asset] : [];
      return assets.map((asset) => ({
        id: `${uploadSession.id}_${asset.id}`,
        sessionId: uploadSession.id,
        fileName: asset.originalName,
        status: asset.blocked ? "blocked" : uploadSession.status,
        createdAt: uploadSession.createdAt,
      }));
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const recentOrders = jobs
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)
    .map((job) => ({
      id: job.id,
      orderName: job.shopifyOrderName,
      status: job.status,
      createdAt: job.createdAt,
    }));

      return data({
        stats,
        recentUploads,
        recentOrders,
        currentPlan: {
          planCode: billingPlan.planCode,
          displayName: planLimits.displayName,
          status: billingPlan.status,
          ordersUsageLabel,
          fileStorageDays: planLimits.fileStorageDays,
        },
      });
    } catch (err) {
      log.error("admin_dashboard_loader_failed", err, { path: "/app" });
      throw err;
    }
  });
};

export default function Index() {
  const navigation = useNavigation();
  const { stats, recentUploads, recentOrders, currentPlan } = useLoaderData<typeof loader>();

  const planStatusTone =
    currentPlan.status === "active"
      ? "success"
      : currentPlan.status === "trial"
        ? "attention"
        : "critical";
  const planStatusLabel =
    currentPlan.status === "active"
      ? "Active"
      : currentPlan.status === "trial"
        ? "Trial"
        : "Inactive";

  if (navigation.state === "loading") {
    return (
      <Page title="PrintDock Dashboard">
        <SkeletonPage primaryAction>
          <Layout>
            <Layout.Section>
              <Card>
                <SkeletonBodyText lines={5} />
              </Card>
            </Layout.Section>
            <Layout.Section>
              <Card>
                <SkeletonBodyText lines={8} />
              </Card>
            </Layout.Section>
          </Layout>
        </SkeletonPage>
      </Page>
    );
  }

  return (
    <Page title="PrintDock Dashboard">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="start" wrap gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Current plan
                  </Text>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="p" variant="headingLg">
                      {currentPlan.displayName}
                    </Text>
                    <Badge tone={planStatusTone}>{planStatusLabel}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {currentPlan.ordersUsageLabel}
                  </Text>
                  <Text as="p" tone="subdued">
                    Uploaded files kept {currentPlan.fileStorageDays} days on this plan.
                  </Text>
                </BlockStack>
                <Button url="/app/plans" variant="secondary">
                  Manage plan
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            {[
              { label: "Orders", value: stats.totalOrders },
              { label: "Conversion Rate", value: `${stats.estimatedConversionRate}%` },
              { label: "Storage Used", value: `${stats.storageUsedMB}MB` },
            ].map((item) => (
              <div key={item.label} style={{ minWidth: 220, flex: 1 }}>
                <Card>
                  <BlockStack gap="100">
                    <Text as="p" variant="heading2xl">
                      {item.value}
                    </Text>
                    <Text as="p" tone="subdued">
                      {item.label}
                    </Text>
                  </BlockStack>
                </Card>
              </div>
            ))}
          </InlineStack>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Quick actions
              </Text>
              <InlineStack gap="200" wrap>
                <Button url="/app/fields/new" variant="primary">
                  New Field
                </Button>
                <Button url="/app/orders">View Orders</Button>
              </InlineStack>
              <Text as="p" tone="subdued">
                Recent uploads this month: {recentUploads.length}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recent Order Jobs
              </Text>
              {recentOrders.length === 0 ? (
                <Text as="p" tone="subdued">
                  No order jobs yet. Jobs will appear once a customer places an order.
                </Text>
              ) : (
                recentOrders.map((order) => (
                  <InlineStack key={order.id} align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="medium">
                        {order.orderName}
                      </Text>
                    </BlockStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="info">{order.status}</Badge>
                      <Text as="p" tone="subdued">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </Text>
                      <Button url={`/app/orders/${order.id}`} variant="plain">
                        View
                      </Button>
                    </InlineStack>
                  </InlineStack>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
