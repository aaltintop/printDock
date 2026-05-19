import { data, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Link,
  Page,
  SkeletonBodyText,
  SkeletonPage,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSignedDownloadUrl } from "../services/storage.server";
import {
  appendOrderJobAuditEvent,
  listOrderJobAuditEvents,
  listOrderJobs,
  saveOrderJob,
} from "../services/shop-data.server";
import { useNewValueEffect } from "../hooks/useNewValueEffect";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function normalizeStatus(status: string) {
  return status === "ready_for_production" ? "approved" : status;
}

function getStatusLabel(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "pending_review") return "Pending review";
  if (normalized === "approved") return "Approved";
  if (normalized === "uploaded") return "Uploaded";
  if (normalized === "reviewed") return "Reviewed";
  return normalized.replaceAll("_", " ");
}

function getStatusTone(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "approved") return "success";
  if (normalized === "pending_review" || normalized === "reviewed") return "warning";
  if (normalized === "uploaded") return "attention";
  return "info";
}

function formatFileSize(sizeBytes: number | null | undefined) {
  if (!sizeBytes || sizeBytes <= 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function buildOrdersUrl(filters: {
  q: string;
  status: string;
  startDate: string;
  endDate: string;
  page?: number;
}) {
  const params = new URLSearchParams();
  if (filters.page && filters.page > 1) {
    params.set("page", String(filters.page));
  }
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  if (filters.startDate) {
    params.set("startDate", filters.startDate);
  }
  if (filters.endDate) {
    params.set("endDate", filters.endDate);
  }
  const query = params.toString();
  return query ? `/app/orders?${query}` : "/app/orders";
}

function getStoreHandleFromDomain(shopDomain: string) {
  return shopDomain.replace(".myshopify.com", "");
}

function buildShopifyOrderAdminUrl(shopDomain: string, orderGid: string) {
  const storeHandle = getStoreHandleFromDomain(shopDomain);
  const orderId = orderGid.replace("gid://shopify/Order/", "");
  return `https://admin.shopify.com/store/${storeHandle}/orders/${orderId}`;
}

async function downloadFileWithoutNavigation(downloadUrl: string, fileName: string) {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error("Failed to download file");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName || "PrintDock-file";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      log.event("admin_page_view", { path: "/app/orders" });
      const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const status = url.searchParams.get("status") || "all";
  const startDate = (url.searchParams.get("startDate") || "").trim();
  const endDate = (url.searchParams.get("endDate") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 20;

  const allOrders = (await listOrderJobs(session.shop))
    .map((orderJob) => {
      const dimensions =
        orderJob.assetSnapshot?.widthInch && orderJob.assetSnapshot?.heightInch
          ? `${orderJob.assetSnapshot.widthInch.toFixed(1)}" × ${orderJob.assetSnapshot.heightInch.toFixed(1)}"`
          : "N/A";
      return {
        id: orderJob.id,
        orderId: orderJob.shopifyOrderId,
        orderName: orderJob.shopifyOrderName,
        lineItemId: orderJob.shopifyLineItemId,
        status: normalizeStatus(orderJob.status),
        createdAt: orderJob.createdAt,
        asset: orderJob.assetSnapshot || null,
        dimensions,
        calculatedPrice: orderJob.calculatedPrice || 0,
        assignee: orderJob.assignee || "",
        internalNotes: orderJob.internalNotes || "",
        tags: orderJob.tags || [],
        ingestStatus: orderJob.ingestStatus,
        ingestEvidence: orderJob.ingestEvidence,
      };
    })
    .filter((order) => {
      const matchesStatus = status === "all" || order.status === status;
      const haystack = `${order.orderName} ${order.asset?.originalName || ""}`.toLowerCase();
      const matchesQuery = query.length === 0 || haystack.includes(query);
      if (!matchesStatus || !matchesQuery) return false;
      if (!startDate && !endDate) return true;
      const createdAt = new Date(order.createdAt);
      if (startDate && createdAt < new Date(startDate)) return false;
      if (endDate) {
        const inclusiveEnd = new Date(endDate);
        inclusiveEnd.setHours(23, 59, 59, 999);
        if (createdAt > inclusiveEnd) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = allOrders.length;
  const quickStats = {
    pendingReview: allOrders.filter((order) => order.status === "pending_review").length,
    approved: allOrders.filter((order) => order.status === "approved").length,
  };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const paginatedOrders = allOrders.slice(start, start + pageSize);
  const orders = await Promise.all(
    paginatedOrders.map(async (order) => {
      const [latestAudit] = await listOrderJobAuditEvents(session.shop, order.id, 1);
      return {
        ...order,
        lastAuditMessage: latestAudit?.message || "No activity yet",
      };
    }),
  );
      return data({
        orders,
        pagination: {
          page: safePage,
          pageSize,
          total,
          pageCount,
        },
        filters: {
          q: query,
          status,
          startDate,
          endDate,
        },
        quickStats,
        shopDomain: session.shop,
      });
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_orders_loader_failed", err, { path: "/app/orders" });
      throw err;
    }
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const formData = await request.formData();
  const intent = String(formData.get("intent") || "download");

  if (intent === "bulk_update") {
    const jobIds = String(formData.get("jobIds") || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const nextStatus = String(formData.get("status") || "");
    if (jobIds.length === 0 || !nextStatus) {
      return data({ error: "Missing bulk update payload" }, { status: 400 });
    }
    const allOrders = await listOrderJobs(session.shop);
    for (const jobId of jobIds) {
      const existing = allOrders.find((order) => order.id === jobId);
      if (!existing) continue;
      await saveOrderJob(session.shop, {
        ...existing,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      });
      await appendOrderJobAuditEvent(session.shop, jobId, {
        eventType: "job_updated",
        message: `status: ${existing.status} -> ${nextStatus}`,
        metadata: { status: nextStatus, source: "bulk_update" },
        actor: "admin-ui",
      });
    }
    return data({ ok: true, message: `${jobIds.length} jobs updated` });
  }

  if (intent === "update_job") {
    const jobId = String(formData.get("jobId") || "");
    if (!jobId) return data({ error: "Missing job id" }, { status: 400 });

    const allOrders = await listOrderJobs(session.shop);
    const existing = allOrders.find((order) => order.id === jobId);
    if (!existing) return data({ error: "Order job not found" }, { status: 404 });

    const nextStatus = String(formData.get("status") || existing.status);
    const nextAssignee = String(formData.get("assignee") || "").trim() || null;
    const nextNotes = String(formData.get("internalNotes") || existing.internalNotes || "");
    const nextTags = String(formData.get("tags") || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    await saveOrderJob(session.shop, {
      ...existing,
      status: nextStatus,
      assignee: nextAssignee,
      internalNotes: nextNotes,
      tags: nextTags,
      updatedAt: new Date().toISOString(),
    });

    const changes = [];
    if (existing.status !== nextStatus) {
      changes.push(`status: ${existing.status} -> ${nextStatus}`);
    }
    if ((existing.assignee || "") !== (nextAssignee || "")) {
      changes.push(`assignee: ${existing.assignee || "unassigned"} -> ${nextAssignee || "unassigned"}`);
    }
    if ((existing.internalNotes || "") !== nextNotes) {
      changes.push("notes updated");
    }
    if ((existing.tags || []).join(",") !== nextTags.join(",")) {
      changes.push("tags updated");
    }
    if (changes.length > 0) {
      await appendOrderJobAuditEvent(session.shop, jobId, {
        eventType: "job_updated",
        message: changes.join(" | "),
        metadata: {
          status: nextStatus,
          assignee: nextAssignee,
          tags: nextTags,
        },
        actor: "admin-ui",
      });
    }

    return data({ ok: true });
  }

  const storagePath = formData.get("storagePath") as string;

  if (!storagePath || !storagePath.startsWith(`uploads/${session.shop}/`)) {
    return data({ error: "Invalid storage path" }, { status: 400 });
  }

  const allJobs = await listOrderJobs(session.shop);
  const jobForPath = allJobs.find((j) => j.assetSnapshot?.storagePath === storagePath);
  if (jobForPath?.assetSnapshot?.storageExpired) {
    return data(
      { error: "This file is no longer stored (retention period ended)." },
      { status: 410 },
    );
  }

  if (
    jobForPath?.ingestStatus === "pending" ||
    jobForPath?.ingestStatus === "processing"
  ) {
    return data(
      { error: "Artwork is still importing. Try again in a moment." },
      { status: 409 },
    );
  }

  if (
    jobForPath?.ingestStatus === "failed" ||
    jobForPath?.ingestEvidence?.anomalyReason === "artwork_unrecoverable"
  ) {
    return data(
      { error: "Artwork file could not be recovered for this order." },
      { status: 410 },
    );
  }

      try {
        const downloadUrl = await getSignedDownloadUrl(storagePath);
        return data({ downloadUrl, storagePath });
      } catch (error) {
        log.error("orders_download_url_failed", error, { storagePath });
        return data({ error: "Failed to generate download link" }, { status: 500 });
      }
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_orders_action_failed", err, { path: "/app/orders" });
      throw err;
    }
  });
};

export default function Orders() {
  const { orders, pagination, filters, quickStats, shopDomain } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionFetcher = useFetcher<typeof action>();
  const downloadFetcher = useFetcher<typeof action>();
  const appBridge = useAppBridge();
  const [downloadingStoragePath, setDownloadingStoragePath] = useState<string | null>(null);
  const [downloadedStoragePath, setDownloadedStoragePath] = useState<string | null>(null);
  const [downloadingFileName, setDownloadingFileName] = useState<string>("PrintDock-file");
  const [updatingStatusJobId, setUpdatingStatusJobId] = useState<string | null>(null);

  // `useNewValueEffect` guarantees one toast per new fetcher response; the
  // previous `useEffect([fetcher.data])` was re-firing on every re-render
  // while `fetcher.data` stayed truthy.
  useNewValueEffect(downloadFetcher.data, (fetcherData) => {
    if ("downloadUrl" in fetcherData && fetcherData.downloadUrl) {
      const completedStoragePath =
        "storagePath" in fetcherData ? String(fetcherData.storagePath || "") : "";
      const downloadUrl = String(fetcherData.downloadUrl);
      void downloadFileWithoutNavigation(downloadUrl, downloadingFileName)
        .then(() => {
          if (completedStoragePath) {
            setDownloadedStoragePath(completedStoragePath);
          }
          setDownloadingStoragePath(null);
          appBridge.toast.show("Downloaded");
        })
        .catch(() => {
          setDownloadingStoragePath(null);
          appBridge.toast.show("Failed to download file", { isError: true });
        });
      return;
    }
    if ("error" in fetcherData && fetcherData.error) {
      setDownloadingStoragePath(null);
      appBridge.toast.show(String(fetcherData.error), { isError: true });
    }
  });

  useNewValueEffect(actionFetcher.data, (fetcherData) => {
    if ("message" in fetcherData && fetcherData.message) {
      appBridge.toast.show(String(fetcherData.message));
    }
    if ("error" in fetcherData && fetcherData.error) {
      appBridge.toast.show(String(fetcherData.error), { isError: true });
    }
  });

  // Keep the per-row "updating" spinner in sync with the fetcher state.
  // This lives in its own effect because it must react to *every* state
  // transition, not just new data payloads.
  useEffect(() => {
    if (actionFetcher.state === "idle") {
      setUpdatingStatusJobId(null);
    }
  }, [actionFetcher.state]);

  const handleDownload = (storagePath: string, fileName: string) => {
    setDownloadingStoragePath(storagePath);
    setDownloadedStoragePath(null);
    setDownloadingFileName(fileName || "PrintDock-file");
    downloadFetcher.submit({ storagePath }, { method: "POST" });
  };

  const handleStatusUpdate = (jobId: string, nextStatus: "pending_review" | "approved") => {
    setUpdatingStatusJobId(jobId);
    actionFetcher.submit(
      {
        intent: "bulk_update",
        status: nextStatus,
        jobIds: jobId,
      },
      { method: "post" },
    );
  };

  if (navigation.state === "loading") {
    return (
      <Page title="Order Jobs">
        <SkeletonPage primaryAction>
          <Card>
            <SkeletonBodyText lines={12} />
          </Card>
        </SkeletonPage>
      </Page>
    );
  }

  return (
    <Page title="Order Jobs">
      <BlockStack gap="400">
        <Card>
          <InlineStack gap="400" align="space-between">
            <Text as="p">Pending review: {quickStats.pendingReview}</Text>
            <Text as="p">Approved: {quickStats.approved}</Text>
          </InlineStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Status guide
            </Text>
            <Text as="p" tone="subdued">
              Uploaded: file received and waiting for a quality check.
            </Text>
            <Text as="p" tone="subdued">
              Pending review: file needs manual review before production.
            </Text>
            <Text as="p" tone="subdued">
              Approved: file is accepted and ready for production.
            </Text>
            <Text as="p" tone="subdued">
              You can change status from quick action buttons in each row or from the order detail
              page.
            </Text>
          </BlockStack>
        </Card>

        <Card padding="0">
          {orders.length === 0 ? (
            <EmptyState
              heading="No order jobs yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Jobs are created automatically when a customer places an order with an uploaded
                file.
              </p>
            </EmptyState>
          ) : (
              <IndexTable
              selectable={false}
              resourceName={{ singular: "order job", plural: "order jobs" }}
              itemCount={orders.length}
              headings={[
                { title: "Order" },
                { title: "Status" },
                { title: "File" },
                { title: "Size" },
                { title: "Dimensions" },
                { title: "Date" },
                { title: "Actions" },
              ]}
            >
              {orders.map((order, index) => (
                <IndexTable.Row id={order.id} key={order.id} position={index}>
                  <IndexTable.Cell>
                    {order.orderId ? (
                      <Link
                        url={buildShopifyOrderAdminUrl(shopDomain, order.orderId)}
                        target="_blank"
                      >
                        {order.orderName || "Unknown"}
                      </Link>
                    ) : (
                      <Text as="span">{order.orderName || "Unknown"}</Text>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={getStatusTone(order.status)}>
                      {getStatusLabel(order.status)}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {order.ingestStatus === "pending" || order.ingestStatus === "processing" ? (
                      <Text as="span" tone="subdued">
                        Artwork importing…
                      </Text>
                    ) : order.ingestEvidence?.anomalyReason === "artwork_unrecoverable" ? (
                      <Text as="span" tone="critical">
                        Artwork missing
                      </Text>
                    ) : order.asset?.storageExpired ? (
                      <Text as="span" tone="subdued">
                        File no longer stored
                      </Text>
                    ) : (
                      (() => {
                        const fileName = order.asset?.originalName || "No File";
                        const truncated =
                          fileName.length > 40 ? `${fileName.slice(0, 40)}...` : fileName;
                        return fileName.length > 40 ? (
                          <Tooltip content={fileName}>
                            <Text as="span">{truncated}</Text>
                          </Tooltip>
                        ) : (
                          truncated
                        );
                      })()
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatFileSize(order.asset?.sizeBytes)}</IndexTable.Cell>
                  <IndexTable.Cell>{order.dimensions}</IndexTable.Cell>
                  <IndexTable.Cell>{new Date(order.createdAt).toLocaleString()}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      {order.status !== "approved" ? (
                        <Button
                          variant="plain"
                          onClick={() => handleStatusUpdate(order.id, "approved")}
                          loading={actionFetcher.state === "submitting" && updatingStatusJobId === order.id}
                        >
                          Mark approved
                        </Button>
                      ) : null}
                      {order.status !== "pending_review" ? (
                        <Button
                          variant="plain"
                          onClick={() => handleStatusUpdate(order.id, "pending_review")}
                          loading={actionFetcher.state === "submitting" && updatingStatusJobId === order.id}
                        >
                          Mark review
                        </Button>
                      ) : null}
                      <Button
                        onClick={() =>
                          order.asset?.storagePath &&
                          !order.asset?.storageExpired &&
                          handleDownload(order.asset.storagePath, order.asset?.originalName || "PrintDock-file")
                        }
                        loading={
                          downloadFetcher.state === "submitting" &&
                          downloadingStoragePath === order.asset?.storagePath
                        }
                        disabled={
                          !order.asset?.storagePath ||
                          Boolean(order.asset?.storageExpired) ||
                          order.ingestStatus === "pending" ||
                          order.ingestStatus === "processing" ||
                          order.ingestStatus === "failed"
                        }
                      >
                        {downloadingStoragePath === order.asset?.storagePath
                          ? "Downloading..."
                          : downloadedStoragePath === order.asset?.storagePath
                            ? "Downloaded"
                            : "Download"}
                      </Button>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>

        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" tone="subdued">
            Page {pagination.page} of {pagination.pageCount} ({pagination.total} results)
          </Text>
          <InlineStack gap="200">
            <Button
              url={buildOrdersUrl({
                q: filters.q,
                status: filters.status,
                startDate: filters.startDate,
                endDate: filters.endDate,
                page: Math.max(1, pagination.page - 1),
              })}
              disabled={pagination.page <= 1}
            >
              Previous
            </Button>
            <Button
              url={buildOrdersUrl({
                q: filters.q,
                status: filters.status,
                startDate: filters.startDate,
                endDate: filters.endDate,
                page: Math.min(pagination.pageCount, pagination.page + 1),
              })}
              disabled={pagination.page >= pagination.pageCount}
            >
              Next
            </Button>
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
