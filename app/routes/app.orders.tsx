import { data, useFetcher, useLoaderData, useNavigation, useSubmit } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  Filters,
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

function normalizeStatus(status: string) {
  return status === "ready_for_production" ? "approved" : status;
}

function getStatusLabel(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "pending_review") return "Pending review";
  if (normalized === "approved") return "Approved";
  if (normalized === "uploaded") return "Uploaded";
  if (normalized === "reupload_requested") return "Re-upload requested";
  if (normalized === "reviewed") return "Reviewed";
  return normalized.replaceAll("_", " ");
}

function getStatusTone(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "approved") return "success";
  if (normalized === "pending_review" || normalized === "reviewed") return "warning";
  if (normalized === "uploaded") return "attention";
  if (normalized === "reupload_requested") return "critical";
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
  exportCsv?: boolean;
}) {
  const params = new URLSearchParams();
  if (filters.page && filters.page > 1) {
    params.set("page", String(filters.page));
  }
  if (filters.exportCsv) {
    params.set("export", "csv");
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
  link.download = fileName || "printdock-file";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  if (url.searchParams.get("export") === "csv") {
    const csvRows = [
      ["Order", "File", "Dimensions", "Price", "Status", "Assignee", "Date"].join(","),
      ...allOrders.map((order) =>
        [
          order.orderName,
          order.asset?.originalName || "No File",
          order.dimensions,
          String(order.calculatedPrice || 0),
          order.status,
          order.assignee || "",
          new Date(order.createdAt).toISOString(),
        ]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];

    return new Response(csvRows.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="printdock-order-jobs.csv"`,
      },
    });
  }

  const total = allOrders.length;
  const quickStats = {
    pendingReview: allOrders.filter((order) => order.status === "pending_review").length,
    approved: allOrders.filter((order) => order.status === "approved").length,
    reuploadRequested: allOrders.filter((order) => order.status === "reupload_requested").length,
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
  const availableStatuses = Array.from(new Set(allOrders.map((order) => order.status)));

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
    availableStatuses,
    shopDomain: session.shop,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  try {
    const downloadUrl = await getSignedDownloadUrl(storagePath);
    return data({ downloadUrl, storagePath });
  } catch (error) {
    console.error("Error generating download URL:", error);
    return data({ error: "Failed to generate download link" }, { status: 500 });
  }
};

export default function Orders() {
  const { orders, pagination, filters, quickStats, availableStatuses, shopDomain } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionFetcher = useFetcher<typeof action>();
  const downloadFetcher = useFetcher<typeof action>();
  const submit = useSubmit();
  const appBridge = useAppBridge();
  const [queryValue, setQueryValue] = useState(filters.q);
  const [statusValue, setStatusValue] = useState(filters.status);
  const [startDateValue, setStartDateValue] = useState(filters.startDate);
  const [endDateValue, setEndDateValue] = useState(filters.endDate);
  const [downloadingStoragePath, setDownloadingStoragePath] = useState<string | null>(null);
  const [downloadedStoragePath, setDownloadedStoragePath] = useState<string | null>(null);
  const [downloadingFileName, setDownloadingFileName] = useState<string>("printdock-file");
  const [updatingStatusJobId, setUpdatingStatusJobId] = useState<string | null>(null);

  useEffect(() => {
    if (downloadFetcher.data && "downloadUrl" in downloadFetcher.data && downloadFetcher.data.downloadUrl) {
      const completedStoragePath =
        "storagePath" in downloadFetcher.data ? String(downloadFetcher.data.storagePath || "") : "";
      const downloadUrl = String(downloadFetcher.data.downloadUrl);
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
    }
    if (downloadFetcher.data && "error" in downloadFetcher.data && downloadFetcher.data.error) {
      setDownloadingStoragePath(null);
      appBridge.toast.show(String(downloadFetcher.data.error), { isError: true });
    }
  }, [appBridge, downloadFetcher.data, downloadingFileName]);

  useEffect(() => {
    if (actionFetcher.data && "message" in actionFetcher.data && actionFetcher.data.message) {
      appBridge.toast.show(String(actionFetcher.data.message));
    }
    if (actionFetcher.data && "error" in actionFetcher.data && actionFetcher.data.error) {
      appBridge.toast.show(String(actionFetcher.data.error), { isError: true });
    }
    if (actionFetcher.state === "idle") {
      setUpdatingStatusJobId(null);
    }
  }, [actionFetcher.data, appBridge]);

  const submitFilterValues = (next: {
    q: string;
    status: string;
    startDate: string;
    endDate: string;
  }) => {
    const nextUrl = buildOrdersUrl(next);
    submit(new URLSearchParams(), { method: "get", action: nextUrl });
  };

  const handleDownload = (storagePath: string, fileName: string) => {
    setDownloadingStoragePath(storagePath);
    setDownloadedStoragePath(null);
    setDownloadingFileName(fileName || "printdock-file");
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

  const appliedFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
    if (filters.q) {
      chips.push({
        key: "q",
        label: `Search: ${filters.q}`,
        onRemove: () => {
          setQueryValue("");
          submitFilterValues({
            q: "",
            status: statusValue,
            startDate: startDateValue,
            endDate: endDateValue,
          });
        },
      });
    }
    if (statusValue !== "all") {
      chips.push({
        key: "status",
        label: `Status: ${getStatusLabel(statusValue)}`,
        onRemove: () => {
          setStatusValue("all");
          submitFilterValues({
            q: queryValue,
            status: "all",
            startDate: startDateValue,
            endDate: endDateValue,
          });
        },
      });
    }
    if (startDateValue) {
      chips.push({
        key: "startDate",
        label: `Start: ${startDateValue}`,
        onRemove: () => {
          setStartDateValue("");
          submitFilterValues({
            q: queryValue,
            status: statusValue,
            startDate: "",
            endDate: endDateValue,
          });
        },
      });
    }
    if (endDateValue) {
      chips.push({
        key: "endDate",
        label: `End: ${endDateValue}`,
        onRemove: () => {
          setEndDateValue("");
          submitFilterValues({
            q: queryValue,
            status: statusValue,
            startDate: startDateValue,
            endDate: "",
          });
        },
      });
    }
    return chips;
  }, [endDateValue, filters.q, queryValue, startDateValue, statusValue]);

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
          <form method="get">
            <BlockStack gap="300">
              <Filters
                queryValue={queryValue}
                queryPlaceholder="Search order number or file name"
                onQueryChange={setQueryValue}
                onQueryClear={() => setQueryValue("")}
                filters={[
                  {
                    key: "status",
                    label: "Status",
                    filter: (
                      <select
                        name="status"
                        value={statusValue}
                        onChange={(event) => setStatusValue(event.target.value)}
                      >
                        <option value="all">All statuses</option>
                        {availableStatuses.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    ),
                  },
                  {
                    key: "startDate",
                    label: "Start date",
                    filter: (
                      <input
                        type="date"
                        name="startDate"
                        value={startDateValue}
                        onChange={(event) => setStartDateValue(event.target.value)}
                      />
                    ),
                  },
                  {
                    key: "endDate",
                    label: "End date",
                    filter: (
                      <input
                        type="date"
                        name="endDate"
                        value={endDateValue}
                        onChange={(event) => setEndDateValue(event.target.value)}
                      />
                    ),
                  },
                ]}
                appliedFilters={appliedFilters}
                onClearAll={() => {
                  setStatusValue("all");
                  setStartDateValue("");
                  setEndDateValue("");
                  setQueryValue("");
                  submitFilterValues({
                    q: "",
                    status: "all",
                    startDate: "",
                    endDate: "",
                  });
                }}
              />
              <InlineStack gap="200">
                <input type="hidden" name="q" value={queryValue} />
                <input type="hidden" name="status" value={statusValue} />
                <input type="hidden" name="startDate" value={startDateValue} />
                <input type="hidden" name="endDate" value={endDateValue} />
                <Button submit>Apply filters</Button>
                <Button
                  url={buildOrdersUrl({
                    q: filters.q,
                    status: filters.status,
                    startDate: filters.startDate,
                    endDate: filters.endDate,
                    exportCsv: true,
                  })}
                >
                  Export CSV
                </Button>
              </InlineStack>
            </BlockStack>
          </form>
        </Card>

        <Card>
          <InlineStack gap="400" align="space-between">
            <Text as="p">Pending review: {quickStats.pendingReview}</Text>
            <Text as="p">Approved: {quickStats.approved}</Text>
            <Text as="p">Re-upload requested: {quickStats.reuploadRequested}</Text>
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
              Re-upload requested: customer must upload a corrected file.
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
                    {(() => {
                      const fileName = order.asset?.originalName || "No File";
                      const truncated = fileName.length > 40 ? `${fileName.slice(0, 40)}...` : fileName;
                      return fileName.length > 40 ? (
                        <Tooltip content={fileName}>
                          <Text as="span">{truncated}</Text>
                        </Tooltip>
                      ) : (
                        truncated
                      );
                    })()}
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
                          handleDownload(order.asset.storagePath, order.asset?.originalName || "printdock-file")
                        }
                        loading={
                          downloadFetcher.state === "submitting" &&
                          downloadingStoragePath === order.asset?.storagePath
                        }
                        disabled={!order.asset?.storagePath}
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
