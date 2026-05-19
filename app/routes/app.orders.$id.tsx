import { useState } from "react";
import { data, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  BlockStack,
  Banner,
  Button,
  Card,
  Layout,
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
  listOrderJobAuditEvents,
  listOrderJobs,
  saveOrderJob,
} from "../services/shop-data.server";
import { useNewValueEffect } from "../hooks/useNewValueEffect";
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
  const [isDownloading, setIsDownloading] = useState(false);

  // `useNewValueEffect` runs once per new fetcher response, so the download
  // doesn't start twice and toasts don't stutter when the page re-renders.
  useNewValueEffect(downloadFetcher.data, (fetcherData) => {
    if ("downloadUrl" in fetcherData && fetcherData.downloadUrl) {
      const downloadUrl = String(fetcherData.downloadUrl);
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
      return;
    }
    if ("error" in fetcherData && fetcherData.error) {
      setIsDownloading(false);
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

  return (
    <Page title={`Order ${job.shopifyOrderName}`} backAction={{ content: "Order jobs", url: "/app/orders" }}>
      <Layout>
        {job.ingestEvidence?.anomalyReason === "artwork_unrecoverable" ? (
          <Layout.Section>
            <Banner tone="critical" title="Artwork file missing">
              <Text as="p">
                This paid order&apos;s artwork could not be recovered from storage after checkout. Contact the
                customer to re-upload, or check Cloud Run logs for order ingest details.
                {job.ingestEvidence.detail ? ` (${job.ingestEvidence.detail})` : ""}
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}
        {job.ingestStatus === "pending" || job.ingestStatus === "processing" ? (
          <Layout.Section>
            <Banner tone="info" title="Artwork importing">
              <Text as="p">
                PrintDock is copying the customer&apos;s upload into order storage. Download will be available shortly.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}
        {job.pricingEvidence?.anomalyReason ? (
          <Layout.Section>
            <Banner tone="warning" title="Upload pricing verification">
              <Text as="p">
                Shopify captured this line without a valid signed upload price ({job.pricingEvidence.anomalyReason}).
                The charged amount may not match the in-app calculation. Compare the order in Shopify Admin with the
                job details below if the customer disputes pricing.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}
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
                  disabled={
                    !job.assetSnapshot?.storagePath ||
                    Boolean(job.assetSnapshot?.storageExpired) ||
                    job.ingestStatus === "pending" ||
                    job.ingestStatus === "processing" ||
                    job.ingestStatus === "failed"
                  }
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
    </Page>
  );
}
