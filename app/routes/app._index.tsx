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
  ProgressBar,
  SkeletonBodyText,
  SkeletonPage,
  Text,
} from "@shopify/polaris";
import { getPlan } from "../config/plans";
import {
  computeDashboardStats,
  getEffectiveBillingPlan,
  listOrderJobs,
} from "../services/shop-data.server";
import {
  ensurePrintDockCartTransformReady,
  syncPrintDockCartTransformHmacMirror,
} from "../services/cart-transform.server";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session, admin } = await authenticate.admin(request);
      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);
      log.event("admin_page_view", { path: "/app" });

      try {
        await ensurePrintDockCartTransformReady(admin, shopDomain);
        await syncPrintDockCartTransformHmacMirror(admin, shopDomain);
      } catch (syncErr) {
        log.warn(
          "cart_transform_hmac_app_home_sync_failed",
          syncErr instanceof Error ? syncErr.message : String(syncErr),
          { shopDomain },
        );
      }

      const [stats, jobs, billingPlan] = await Promise.all([
        computeDashboardStats(shopDomain),
        listOrderJobs(shopDomain),
        getEffectiveBillingPlan(shopDomain),
      ]);

      const planLimits = getPlan(billingPlan.planCode);
      const storageCapMB =
        Math.round((planLimits.maxTotalStorageBytes / (1024 * 1024)) * 100) / 100;
      const storageUsageLabel = `Upload storage: ${stats.storageUsedMB} / ${storageCapMB} MB`;

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
        recentOrders,
        currentPlan: {
          planCode: billingPlan.planCode,
          displayName: planLimits.displayName,
          status: billingPlan.status,
          storageUsageLabel,
          storageUsedMB: stats.storageUsedMB,
          storageCapMB,
          fileStorageDays: planLimits.fileStorageDays,
        },
      });
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_dashboard_loader_failed", err, { path: "/app" });
      throw err;
    }
  });
};

export default function Index() {
  const navigation = useNavigation();
  const { stats, recentOrders, currentPlan } = useLoaderData<typeof loader>();

  const storageProgress =
    currentPlan.storageCapMB > 0
      ? Math.min(100, Math.round((currentPlan.storageUsedMB / currentPlan.storageCapMB) * 100))
      : 0;
  const storageNearCap = storageProgress >= 90;

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
      : currentPlan.status === "active"
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
                    {currentPlan.storageUsageLabel}
                  </Text>
                  <ProgressBar progress={storageProgress} size="small" tone={storageNearCap ? "critical" : "highlight"} />
                  <Text as="p" tone="subdued">
                    Uploaded files kept {currentPlan.fileStorageDays} days on this plan.
                  </Text>
                </BlockStack>
                <Button url="/app/plans" variant={storageNearCap ? "primary" : "secondary"}>
                  {storageNearCap ? "Upgrade plan" : "Manage plan"}
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
