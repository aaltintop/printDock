import { useEffect, useState } from "react";
import { data, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  BlockStack,
  Button,
  Card,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSignedDownloadUrl } from "../services/storage.server";
import {
  appendOrderJobAuditEvent,
  createReuploadRequest,
  listOrderJobAuditEvents,
  listOrderJobs,
  saveOrderJob,
} from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

function normalizeStatus(status: string) {
  return status === "ready_for_production" ? "approved" : status;
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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const jobId = String(params.id || "");
      log.event("admin_page_view", { path: `/app/orders/${jobId}` });
      const jobs = await listOrderJobs(session.shop);
      const job = jobs.find((item) => item.id === jobId);
      if (!job) {
        throw data({ error: "Order job not found" }, { status: 404 });
      }
      const audit = await listOrderJobAuditEvents(session.shop, jobId, 30);
      return data({ job, audit });
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_order_detail_loader_failed", err, {
        path: `/app/orders/${params.id || ""}`,
      });
      throw err;
    }
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      const jobId = String(params.id || "");
      const jobs = await listOrderJobs(session.shop);
      const job = jobs.find((item) => item.id === jobId);
      if (!job) {
        return data({ error: "Order job not found" }, { status: 404 });
      }

      const formData = await request.formData();
      const intent = String(formData.get("intent") || "");

      if (intent === "download") {
        log.event("order_job_download_requested", { jobId });
    const storagePath = String(formData.get("storagePath") || "");
    if (!storagePath || !storagePath.startsWith(`uploads/${session.shop}/`)) {
      return data({ error: "Invalid storage path" }, { status: 400 });
    }
    if (job.assetSnapshot?.storageExpired) {
      return data(
        { error: "This file is no longer stored (retention period ended)." },
        { status: 410 },
      );
    }
        const downloadUrl = await getSignedDownloadUrl(storagePath);
        return data({ downloadUrl, storagePath });
      }

      if (intent === "update_status") {
        log.event("order_job_status_updated", { jobId });
        const status = normalizeStatus(String(formData.get("status") || job.status));
        await saveOrderJob(session.shop, { ...job, status });
        await appendOrderJobAuditEvent(session.shop, jobId, {
          eventType: "job_updated",
          message: `status changed to ${status}`,
          metadata: { status },
          actor: "admin-ui",
        });
        return data({ ok: true, message: "Status updated" });
      }

      if (intent === "save_note") {
        log.event("order_job_note_saved", { jobId });
        const internalNotes = String(formData.get("internalNotes") || "");
        await saveOrderJob(session.shop, { ...job, internalNotes });
        await appendOrderJobAuditEvent(session.shop, jobId, {
          eventType: "job_updated",
          message: "internal note updated",
          metadata: { internalNotes },
          actor: "admin-ui",
        });
        return data({ ok: true, message: "Internal note saved" });
      }

      if (intent === "request_reupload") {
        log.event("order_job_reupload_requested", { jobId });
        const token = await createReuploadRequest(session.shop, jobId);
        await saveOrderJob(session.shop, { ...job, status: "reupload_requested" });
        await appendOrderJobAuditEvent(session.shop, jobId, {
          eventType: "job_updated",
          message: "re-upload requested",
          metadata: { status: "reupload_requested", token },
          actor: "admin-ui",
        });

        const url = new URL(request.url);
        const origin = url.origin;
        const reuploadUrl = `${origin}/api/reupload/${token}`;

        return data({ ok: true, message: "Re-upload requested", reuploadUrl });
      }

      log.warn("order_detail_unknown_intent", "Unsupported order detail intent", { intent });
      return data({ error: "Unsupported action" }, { status: 400 });
    } catch (err) {
      if (err instanceof Response) throw err;
      log.error("admin_order_detail_action_failed", err, {
        path: `/app/orders/${params.id || ""}`,
      });
      throw err;
    }
  });
};

export default function OrderJobDetailPage() {
  const { job, audit } = useLoaderData<typeof loader>();
  const actionFetcher = useFetcher<typeof action>();
  const downloadFetcher = useFetcher<typeof action>();
  const appBridge = useAppBridge();
  const [status, setStatus] = useState(normalizeStatus(job.status));
  const [internalNotes, setInternalNotes] = useState(job.internalNotes || "");
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [reuploadUrl, setReuploadUrl] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (downloadFetcher.data && "downloadUrl" in downloadFetcher.data && downloadFetcher.data.downloadUrl) {
      const downloadUrl = String(downloadFetcher.data.downloadUrl);
      void downloadFileWithoutNavigation(
        downloadUrl,
        job.assetSnapshot?.originalName || "PrintDock-file",
      )
        .then(() => {
          setIsDownloading(false);
          appBridge.toast.show("Downloaded");
        })
        .catch(() => {
          setIsDownloading(false);
          appBridge.toast.show("Failed to download file", { isError: true });
        });
    }
    if (downloadFetcher.data && "error" in downloadFetcher.data && downloadFetcher.data.error) {
      setIsDownloading(false);
      appBridge.toast.show(String(downloadFetcher.data.error), { isError: true });
    }
  }, [appBridge, downloadFetcher.data, job.assetSnapshot?.originalName]);

  useEffect(() => {
    if (actionFetcher.data && "reuploadUrl" in actionFetcher.data && actionFetcher.data.reuploadUrl) {
      setReuploadUrl(actionFetcher.data.reuploadUrl as string);
    }
    if (actionFetcher.data && "message" in actionFetcher.data && actionFetcher.data.message) {
      appBridge.toast.show(String(actionFetcher.data.message));
    }
    if (actionFetcher.data && "error" in actionFetcher.data && actionFetcher.data.error) {
      appBridge.toast.show(String(actionFetcher.data.error), { isError: true });
    }
  }, [actionFetcher.data, appBridge]);

  return (
    <Page title={`Order ${job.shopifyOrderName}`} backAction={{ content: "Order jobs", url: "/app/orders" }}>
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                File Preview
              </Text>
              {job.assetSnapshot?.storageExpired ? (
                <Text as="p" tone="subdued">
                  This file is no longer stored (retention period ended). The order record is kept for
                  your history.
                </Text>
              ) : null}
              <Text as="p">{job.assetSnapshot?.originalName || "No file attached"}</Text>
              <Text as="p" tone="subdued">
                {(job.assetSnapshot?.widthInch || 0).toFixed(1)}&quot; x {(job.assetSnapshot?.heightInch || 0).toFixed(1)}
                &quot; | {job.assetSnapshot?.dpi || "N/A"} DPI
              </Text>
              <Text as="p" tone="subdued">
                {((job.assetSnapshot?.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB |{" "}
                {job.assetSnapshot?.fileExtension?.toUpperCase() || "N/A"}
              </Text>
              <downloadFetcher.Form method="post">
                <input type="hidden" name="intent" value="download" />
                <input type="hidden" name="storagePath" value={job.assetSnapshot?.storagePath || ""} />
                <Button
                  submit
                  loading={isDownloading}
                  disabled={!job.assetSnapshot?.storagePath || Boolean(job.assetSnapshot?.storageExpired)}
                  onClick={() => setIsDownloading(true)}
                >
                  {isDownloading ? "Downloading..." : "Download Original"}
                </Button>
              </downloadFetcher.Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Job Details
                </Text>
                <Text as="p">Product ID: {job.productId || "N/A"}</Text>
                <actionFetcher.Form method="post">
                  <BlockStack gap="200">
                    <input type="hidden" name="intent" value="update_status" />
                    <Select
                      label="Status"
                      name="status"
                      value={status}
                      options={[
                        { label: "Uploaded", value: "uploaded" },
                        { label: "Pending review", value: "pending_review" },
                        { label: "Approved", value: "approved" },
                        { label: "Re-upload requested", value: "reupload_requested" },
                      ]}
                      onChange={setStatus}
                    />
                    <Button submit>Save status</Button>
                  </BlockStack>
                </actionFetcher.Form>
              </BlockStack>
            </Card>

            <Card>
              <actionFetcher.Form method="post">
                <BlockStack gap="200">
                  <input type="hidden" name="intent" value="save_note" />
                  <TextField
                    label="Internal Notes"
                    name="internalNotes"
                    multiline={4}
                    autoComplete="off"
                    value={internalNotes}
                    onChange={setInternalNotes}
                  />
                  <Button submit>Save Note</Button>
                </BlockStack>
              </actionFetcher.Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Button tone="critical" onClick={() => setRequestModalOpen(true)}>
                  Request Re-upload
                </Button>
                {reuploadUrl && (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">Share this link with the customer to re-upload their file:</Text>
                    <TextField
                      label="Re-upload URL"
                      labelHidden
                      value={reuploadUrl}
                      autoComplete="off"
                      readOnly
                      selectTextOnFocus
                    />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Audit History
              </Text>
              {audit.length === 0 ? (
                <Text as="p" tone="subdued">
                  No audit events yet.
                </Text>
              ) : (
                audit.map((event) => (
                  <Text as="p" key={event.id}>
                    {new Date(event.createdAt).toLocaleString()} - {event.message}
                  </Text>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={requestModalOpen}
        onClose={() => setRequestModalOpen(false)}
        title="Request re-upload"
        primaryAction={{
          content: "Send request",
          onAction: () => {
            actionFetcher.submit({ intent: "request_reupload" }, { method: "post" });
            setRequestModalOpen(false);
          },
          destructive: true,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRequestModalOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            This will update the job status and mark this order as waiting for a new upload.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
