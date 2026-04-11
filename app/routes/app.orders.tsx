import { data } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
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
        customerEmail: orderJob.customerEmail,
        shippingAddress: orderJob.shippingAddress || null,
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
      const haystack = `${order.orderName} ${order.customerEmail} ${order.asset?.originalName || ""}`.toLowerCase();
      const matchesQuery = query.length === 0 || haystack.includes(query);
      return matchesStatus && matchesQuery;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (url.searchParams.get("export") === "csv") {
    const csvRows = [
      ["Order", "Customer", "File", "Dimensions", "Price", "Status", "Assignee", "Date"].join(","),
      ...allOrders.map((order) =>
        [
          order.orderName,
          order.customerEmail || "N/A",
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
    },
    availableStatuses,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "download");

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
  const { orders, pagination, filters, availableStatuses } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.data && "downloadUrl" in fetcher.data && fetcher.data.downloadUrl) {
      window.open(fetcher.data.downloadUrl as string, "_blank");
    }
  }, [fetcher.data]);

  const handleDownload = (storagePath: string) => {
    fetcher.submit(
      { storagePath },
      { method: "POST" }
    );
  };

  return (
    <s-page heading="Order Jobs">
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <form method="get" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="search"
            name="q"
            placeholder="Search order, customer, file"
            defaultValue={filters.q}
          />
          <select name="status" defaultValue={filters.status}>
            <option value="all">All statuses</option>
            {availableStatuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button type="submit">Filter</button>
          <s-button
            href={`/app/orders?export=csv&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
          >
            Export CSV
          </s-button>
        </form>
      </s-box>

      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-table>
          <s-table-header-row>
            <s-table-header>Order</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Address</s-table-header>
            <s-table-header>File</s-table-header>
            <s-table-header>Dimensions</s-table-header>
            <s-table-header>Price</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Assignee / Notes</s-table-header>
            <s-table-header>Latest Audit</s-table-header>
            <s-table-header>Date</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map(({ id, orderName, customerEmail, shippingAddress, status, createdAt, asset, dimensions, calculatedPrice, assignee, internalNotes, tags, lastAuditMessage }) => {
              const date = new Date(createdAt).toLocaleString();
              
              // Format the address into a readable string
              let addressString = "N/A";
              if (shippingAddress) {
                const parts = [
                  shippingAddress.address1,
                  shippingAddress.address2,
                  shippingAddress.city,
                  shippingAddress.province_code,
                  shippingAddress.zip,
                  shippingAddress.country_code
                ].filter(Boolean);
                addressString = parts.join(", ");
              }
              
              return (
                <s-table-row key={id}>
                  <s-table-cell>
                    <s-text>
                      {orderName || "Unknown"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>{customerEmail || "N/A"}</s-table-cell>
                  <s-table-cell>{addressString}</s-table-cell>
                  <s-table-cell>{asset?.originalName || "No File"}</s-table-cell>
                  <s-table-cell>{dimensions}</s-table-cell>
                  <s-table-cell>${Number(calculatedPrice || 0).toFixed(2)}</s-table-cell>
                  <s-table-cell>{status}</s-table-cell>
                  <s-table-cell>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="update_job" />
                      <input type="hidden" name="jobId" value={id} />
                      <div style={{ display: "grid", gap: 6 }}>
                        <select name="status" defaultValue={status}>
                          <option value="uploaded">uploaded</option>
                          <option value="reviewed">reviewed</option>
                          <option value="printed">printed</option>
                          <option value="shipped">shipped</option>
                          <option value="completed">completed</option>
                        </select>
                        <input name="assignee" placeholder="Assignee" defaultValue={assignee || ""} />
                        <input name="internalNotes" placeholder="Internal note" defaultValue={internalNotes || ""} />
                        <input name="tags" placeholder="tags,comma,separated" defaultValue={(tags || []).join(",")} />
                        <button type="submit">Save</button>
                      </div>
                    </fetcher.Form>
                  </s-table-cell>
                  <s-table-cell>{lastAuditMessage}</s-table-cell>
                  <s-table-cell>{date}</s-table-cell>
                  <s-table-cell>
                    {asset?.storagePath ? (
                      <s-stack direction="inline" gap="base">
                        <s-button
                          onClick={() => handleDownload(asset.storagePath)}
                          {...(fetcher.state === "submitting" && fetcher.formData?.get("storagePath") === asset.storagePath ? { loading: true } : {})}
                        >
                          Download
                        </s-button>
                        <s-button
                          onClick={() => handleDownload(asset.storagePath)}
                        >
                          Preview
                        </s-button>
                      </s-stack>
                    ) : (
                      <s-text>N/A</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-box>

      <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text>
            Page {pagination.page} of {pagination.pageCount} ({pagination.total} results)
          </s-text>
          <s-button
            href={`/app/orders?page=${Math.max(1, pagination.page - 1)}&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
            disabled={pagination.page <= 1}
          >
            Previous
          </s-button>
          <s-button
            href={`/app/orders?page=${Math.min(pagination.pageCount, pagination.page + 1)}&q=${encodeURIComponent(filters.q)}&status=${encodeURIComponent(filters.status)}`}
            disabled={pagination.page >= pagination.pageCount}
          >
            Next
          </s-button>
        </s-stack>
      </s-box>
    </s-page>
  );
}
