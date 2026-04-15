import { useEffect, useState } from "react";
import { data, useLoaderData, useFetcher, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  Filters,
  Icon,
  IndexTable,
  Page,
  SkeletonBodyText,
  SkeletonPage,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { FileIcon, ImageIcon, NoteIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { getSignedDownloadUrl } from "../services/storage.server";
import { listOrderJobs, listUploadSessions } from "../services/shop-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const sessionFilter = (url.searchParams.get("session") || "").trim();
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = (url.searchParams.get("status") || "all").trim().toLowerCase();
  const startDate = (url.searchParams.get("startDate") || "").trim();
  const endDate = (url.searchParams.get("endDate") || "").trim();

  const [sessions, jobs] = await Promise.all([
    listUploadSessions(session.shop),
    listOrderJobs(session.shop),
  ]);
  const orderBySessionId = new Map(
    jobs
      .filter((job) => Boolean(job.sessionId))
      .map((job) => [job.sessionId, { id: job.id, name: job.shopifyOrderName }]),
  );

  const uploads = sessions
    .map((uploadSession) => {
      const asset = uploadSession.asset ?? uploadSession.assets[0] ?? null;
      return {
        id: uploadSession.id,
        status: uploadSession.status,
        createdAt: uploadSession.createdAt || new Date().toISOString(),
        asset,
        productId: uploadSession.productId,
        orderJob: orderBySessionId.get(uploadSession.id) ?? null,
      };
    })
    .filter((u) => u.asset !== null)
    .filter((upload) => {
      if (sessionFilter && upload.id !== sessionFilter) return false;
      if (!query) return true;
      const haystack = `${upload.id} ${upload.asset?.originalName || ""} ${upload.productId}`.toLowerCase();
      return haystack.includes(query);
    })
    .filter((upload) => statusFilter === "all" || upload.status.toLowerCase() === statusFilter)
    .filter((upload) => {
      if (!startDate && !endDate) return true;
      const createdAt = new Date(upload.createdAt);
      if (startDate && createdAt < new Date(startDate)) return false;
      if (endDate) {
        const inclusiveEnd = new Date(endDate);
        inclusiveEnd.setHours(23, 59, 59, 999);
        if (createdAt > inclusiveEnd) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return data({
    uploads,
    filters: {
      session: sessionFilter,
      q: query,
      status: statusFilter,
      startDate,
      endDate,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
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

export default function Uploads() {
  const { uploads, filters } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const [queryValue, setQueryValue] = useState(filters.q);
  const [statusValue, setStatusValue] = useState(filters.status);
  const [startDateValue, setStartDateValue] = useState(filters.startDate);
  const [endDateValue, setEndDateValue] = useState(filters.endDate);

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

  const getStatusTone = (status: string) => {
    const normalized = status.toLowerCase();
    if (normalized === "success") return "success";
    if (normalized === "converted") return "attention";
    if (normalized === "blocked" || normalized === "error") return "critical";
    return "info";
  };

  const getFileIcon = (extension = "") => {
    const normalized = extension.toLowerCase();
    if (["png", "jpg", "jpeg", "webp"].includes(normalized)) return ImageIcon;
    if (["pdf"].includes(normalized)) return NoteIcon;
    return FileIcon;
  };

  return (
    navigation.state === "loading" ? (
      <Page title="Customer Uploads">
        <SkeletonPage primaryAction>
          <Card>
            <SkeletonBodyText lines={8} />
          </Card>
        </SkeletonPage>
      </Page>
    ) : (
    <Page title="Customer Uploads">
      <BlockStack gap="400">
        <Card>
          <form method="get">
            <Filters
              queryValue={queryValue}
              queryPlaceholder="Search by filename"
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
                      <option value="all">All</option>
                      <option value="success">Success</option>
                      <option value="converted">Converted</option>
                      <option value="error">Error</option>
                      <option value="blocked">Blocked</option>
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
            <input type="hidden" name="q" value={queryValue} />
            <Button submit>Apply filters</Button>
          </form>
        </Card>

        <Card padding="0">
          {uploads.length === 0 ? (
            <EmptyState
              heading="No uploads yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Uploads will appear here once customers submit artwork on your product pages.
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "upload", plural: "uploads" }}
              itemCount={uploads.length}
              headings={[
                { title: "Preview" },
                { title: "File Name" },
                { title: "Order" },
                { title: "Status" },
                { title: "Size" },
                { title: "Upload Date" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {uploads.map(({ id, status, createdAt, asset, orderJob }, index) => {
                const date = new Date(createdAt).toLocaleString();
                const sizeMB = asset?.sizeBytes
                  ? `${(asset.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
                  : "N/A";
                const fileName = asset?.originalName || "Unknown";
                const shortName =
                  fileName.length > 40 ? `${fileName.slice(0, 37)}...` : fileName;
                return (
                  <IndexTable.Row id={id} key={id} position={index}>
                    <IndexTable.Cell>
                      <Icon source={getFileIcon(asset?.fileExtension)} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Tooltip content={fileName}>
                        <Text as="span">{shortName}</Text>
                      </Tooltip>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {orderJob ? (
                        <Button url={`/app/orders/${orderJob.id}`} variant="plain">
                          {orderJob.name || "View order"}
                        </Button>
                      ) : (
                        <Text as="span" tone="subdued">
                          Not linked
                        </Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={getStatusTone(status)}>{status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{sizeMB}</IndexTable.Cell>
                    <IndexTable.Cell>{date}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Button
                          onClick={() => asset?.storagePath && handleDownload(asset.storagePath)}
                          loading={
                            fetcher.state === "submitting" &&
                            fetcher.formData?.get("storagePath") === asset?.storagePath
                          }
                          disabled={!asset?.storagePath}
                        >
                          Download
                        </Button>
                        <Button
                          url={orderJob ? `/app/orders/${orderJob.id}` : `/app/orders?q=${encodeURIComponent(id)}`}
                          variant="plain"
                        >
                          {orderJob ? "View Order" : "Find Order"}
                        </Button>
                      </BlockStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
    )
  );
}
