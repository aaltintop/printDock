import { data, useLoaderData, useFetcher, useNavigation } from "react-router";
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
  useIndexResourceState,
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
        status: orderJob.status,
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

  if (intent === "bulk_zip") {
    return data({ ok: true, message: "ZIP export has been queued for selected jobs." });
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
    return data({ downloadUrl });
  } catch (error) {
    console.error("Error generating download URL:", error);
    return data({ error: "Failed to generate download link" }, { status: 500 });
  }
};

export default function Orders() {
  const { orders, pagination, filters, availableStatuses, shopDomain } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const appBridge = useAppBridge();
  const [queryValue, setQueryValue] = useState(filters.q);
  const [statusValue, setStatusValue] = useState(filters.status);
  const [startDateValue, setStartDateValue] = useState(filters.startDate);
  const [endDateValue, setEndDateValue] = useState(filters.endDate);
  const { selectedResources, handleSelectionChange } = useIndexResourceState(
    orders,
  );

  useEffect(() => {
    if (fetcher.data && "downloadUrl" in fetcher.data && fetcher.data.downloadUrl) {
      window.open(fetcher.data.downloadUrl as string, "_blank");
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (fetcher.data && "message" in fetcher.data && fetcher.data.message) {
      appBridge.toast.show(String(fetcher.data.message));
    }
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      appBridge.toast.show(String(fetcher.data.error), { isError: true });
    }
  }, [appBridge, fetcher.data]);

  const handleDownload = (storagePath: string) => {
    fetcher.submit(
      { storagePath },
      { method: "POST" }
    );
  };

  const promotedBulkActions = useMemo(
    () => [
      {
        content: "Download ZIP",
        onAction: () =>
          fetcher.submit(
            {
              intent: "bulk_zip",
              jobIds: selectedResources.join(","),
            },
            { method: "post" },
          ),
      },
      {
        content: "Mark as Approved",
        onAction: () =>
          fetcher.submit(
            {
              intent: "bulk_update",
              status: "approved",
              jobIds: selectedResources.join(","),
            },
            { method: "post" },
          ),
      },
      {
        content: "Mark as Ready for Production",
        onAction: () =>
          fetcher.submit(
            {
              intent: "bulk_update",
              status: "ready_for_production",
              jobIds: selectedResources.join(","),
            },
            { method: "post" },
          ),
      },
    ],
    [fetcher, selectedResources],
  );

  const statusTone = (status: string) => {
    const normalized = status.toLowerCase();
    if (normalized === "ready_for_production") return "success";
    if (normalized === "approved") return "info";
    if (normalized === "pending_review" || normalized === "reviewed") return "warning";
    if (normalized === "uploaded") return "attention";
    if (normalized === "reupload_requested") return "critical";
    return "info";
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
                appliedFilters={[]}
                onClearAll={() => {
                  setStatusValue("all");
                  setStartDateValue("");
                  setEndDateValue("");
                  setQueryValue("");
                }}
              />
              <InlineStack gap="200">
                <input type="hidden" name="q" value={queryValue} />
                <Button submit>Apply filters</Button>
                <Button
                  url={`/app/orders?export=csv&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
                >
                  Export CSV
                </Button>
              </InlineStack>
            </BlockStack>
          </form>
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
              resourceName={{ singular: "order job", plural: "order jobs" }}
              itemCount={orders.length}
              selectedItemsCount={selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={promotedBulkActions}
              headings={[
                { title: "Order" },
                { title: "Status" },
                { title: "File" },
                { title: "Dimensions" },
                { title: "Date" },
                { title: "Actions" },
              ]}
            >
              {orders.map((order, index) => (
                <IndexTable.Row id={order.id} key={order.id} position={index}>
                  <IndexTable.Cell>
                    <Link url={`https://${shopDomain}/admin/orders/${order.orderId ? order.orderId.replace("gid://shopify/Order/", "") : ""}`} target="_blank">
                      {order.orderName || "Unknown"}
                    </Link>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={statusTone(order.status)}>
                      {order.status.replaceAll("_", " ")}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {(order.asset?.originalName || "No File").slice(0, 40)}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{order.dimensions}</IndexTable.Cell>
                  <IndexTable.Cell>{new Date(order.createdAt).toLocaleString()}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      <Button url={`/app/orders/${order.id}`} variant="plain">
                        View
                      </Button>
                      <Button
                        onClick={() => order.asset?.storagePath && handleDownload(order.asset.storagePath)}
                        loading={
                          fetcher.state === "submitting" &&
                          fetcher.formData?.get("storagePath") === order.asset?.storagePath
                        }
                        disabled={!order.asset?.storagePath}
                      >
                        Download
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
              url={`/app/orders?page=${Math.max(1, pagination.page - 1)}&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
              disabled={pagination.page <= 1}
            >
              Previous
            </Button>
            <Button
              url={`/app/orders?page=${Math.min(pagination.pageCount, pagination.page + 1)}&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
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
