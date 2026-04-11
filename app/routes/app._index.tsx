import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
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
      fileName: job.assetSnapshot?.originalName ?? "N/A",
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
  const { stats, recentUploads, recentOrders, onboardingChecklist } = useLoaderData<typeof loader>();

  return (
    <s-page heading="PrintDock Dashboard">
      <s-stack direction="block" gap="base">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Performance Snapshot</s-heading>
          <s-stack direction="inline" gap="base">
            <s-card>
              <s-text>Total uploads: {stats.totalUploads}</s-text>
            </s-card>
            <s-card>
              <s-text>Total orders: {stats.totalOrders}</s-text>
            </s-card>
            <s-card>
              <s-text>Blocked uploads: {stats.blockedUploads}</s-text>
            </s-card>
            <s-card>
              <s-text>Conversion rate: {stats.estimatedConversionRate}%</s-text>
            </s-card>
            <s-card>
              <s-text>Storage used: {stats.storageUsedMB}MB</s-text>
            </s-card>
          </s-stack>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Onboarding Checklist</s-heading>
          <s-stack direction="block" gap="base">
            {onboardingChecklist.map((item) => (
              <s-stack key={item.id} direction="inline" justifyContent="space-between" alignItems="center">
                <s-text>{item.label}</s-text>
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone={item.done ? "success" : "critical"}>
                    {item.done ? "Done" : "Pending"}
                  </s-badge>
                  <s-button href={item.href}>{item.done ? "Review" : "Complete"}</s-button>
                </s-stack>
              </s-stack>
            ))}
          </s-stack>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Quick Links</s-heading>
          <s-stack direction="inline" gap="base">
            <s-button href="/app/fields/new">New Field</s-button>
            <s-button href="/app/uploads">Uploads</s-button>
            <s-button href="/app/orders">Orders</s-button>
            <s-button href="/app/settings">Settings</s-button>
            <s-button href="/app/plans">Plans</s-button>
          </s-stack>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Recent Uploads</s-heading>
          <s-table>
            <s-table-header-row>
              <s-table-header>File</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentUploads.map((upload) => (
                <s-table-row key={upload.id}>
                  <s-table-cell>{upload.fileName}</s-table-cell>
                  <s-table-cell>{upload.status}</s-table-cell>
                  <s-table-cell>{new Date(upload.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-heading>Recent Order Jobs</s-heading>
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>File</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentOrders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>{order.orderName}</s-table-cell>
                  <s-table-cell>{order.fileName}</s-table-cell>
                  <s-table-cell>{order.status}</s-table-cell>
                  <s-table-cell>{new Date(order.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-box>
      </s-stack>
    </s-page>
  );
}
