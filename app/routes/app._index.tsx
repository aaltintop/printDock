import { data, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Icon,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  SkeletonBodyText,
  SkeletonPage,
  Text,
} from "@shopify/polaris";
import { CheckCircleIcon, XCircleIcon } from "@shopify/polaris-icons";
import { db } from "../firebase.server";
import {
  computeDashboardStats,
  listOrderJobs,
  listUploadFields,
  listUploadSessions,
} from "../services/shop-data.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [stats, fields, sessions, jobs, shopDoc] = await Promise.all([
    computeDashboardStats(shopDomain),
    listUploadFields(shopDomain),
    listUploadSessions(shopDomain),
    listOrderJobs(shopDomain),
    db.collection("shops").doc(shopDomain).get(),
  ]);

  const shopData = shopDoc.data() ?? {};
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
      customerEmail: job.customerEmail ?? "N/A",
      status: job.status,
      createdAt: job.createdAt,
    }));

  const onboardingChecklist = [
    {
      id: "setup",
      label: "Complete setup wizard",
      done: Boolean(shopData.cartValidationVerified && shopData.cartTransformVerified),
      href: "/app/onboarding",
    },
    {
      id: "field",
      label: "Create at least one upload field",
      done: fields.length > 0,
      href: "/app/fields/new",
    },
    {
      id: "upload",
      label: "Receive first customer upload",
      done: stats.totalUploads > 0,
      href: "/app/uploads",
    },
    {
      id: "order",
      label: "Process first order job",
      done: stats.totalOrders > 0,
      href: "/app/orders",
    },
  ];

  return data({
    stats,
    recentUploads,
    recentOrders,
    onboardingChecklist,
  });
};

export default function Index() {
  const navigation = useNavigation();
  const { stats, recentUploads, recentOrders, onboardingChecklist } = useLoaderData<typeof loader>();
  const completedSteps = onboardingChecklist.filter((item) => item.done).length;
  const completionPercent = onboardingChecklist.length
    ? Math.round((completedSteps / onboardingChecklist.length) * 100)
    : 0;

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
          <InlineStack gap="400" wrap>
            {[
              { label: "Uploads", value: stats.totalUploads },
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
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Onboarding
                </Text>
                <Badge tone={completedSteps === onboardingChecklist.length ? "success" : "attention"}>
                  {`${completedSteps}/${onboardingChecklist.length} complete`}
                </Badge>
              </InlineStack>
              <ProgressBar progress={completionPercent} size="small" />
              {onboardingChecklist.map((item) => (
                <InlineStack key={item.id} align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={item.done ? CheckCircleIcon : XCircleIcon} tone={item.done ? "success" : "subdued"} />
                    <Text as="p">{item.label}</Text>
                  </InlineStack>
                  <Button url={item.href} variant="plain">
                    {item.done ? "Review" : "Complete"}
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
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
                <Button url="/app/uploads">View Uploads</Button>
                <Button url="/app/settings">Settings</Button>
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
                      <Text as="p" tone="subdued">
                        {order.customerEmail}
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
