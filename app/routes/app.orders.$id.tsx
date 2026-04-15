import { useEffect, useState } from "react";
import { data, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { BlockStack, Button, Card, Layout, Modal, Page, Select, Text, TextField } from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSignedDownloadUrl } from "../services/storage.server";
import {
  appendOrderJobAuditEvent,
  listOrderJobAuditEvents,
  listOrderJobs,
  saveOrderJob,
} from "../services/shop-data.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobId = String(params.id || "");
  const jobs = await listOrderJobs(session.shop);
  const job = jobs.find((item) => item.id === jobId);
  if (!job) {
    throw data({ error: "Order job not found" }, { status: 404 });
  }
  const audit = await listOrderJobAuditEvents(session.shop, jobId, 30);
  return data({ job, audit });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobId = String(params.id || "");
  const jobs = await listOrderJobs(session.shop);
  const job = jobs.find((item) => item.id === jobId);
  if (!job) {
    return data({ error: "Order job not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "download") {
    const storagePath = String(formData.get("storagePath") || "");
    if (!storagePath || !storagePath.startsWith(`uploads/${session.shop}/`)) {
      return data({ error: "Invalid storage path" }, { status: 400 });
    }
    const downloadUrl = await getSignedDownloadUrl(storagePath);
    return data({ downloadUrl });
  }

  if (intent === "update_status") {
    const status = String(formData.get("status") || job.status);
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
    await saveOrderJob(session.shop, { ...job, status: "reupload_requested" });
    await appendOrderJobAuditEvent(session.shop, jobId, {
      eventType: "job_updated",
      message: "re-upload requested",
      metadata: { status: "reupload_requested" },
      actor: "admin-ui",
    });
    return data({ ok: true, message: "Re-upload requested" });
  }

  return data({ error: "Unsupported action" }, { status: 400 });
};

export default function OrderJobDetailPage() {
  const { job, audit } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const appBridge = useAppBridge();
  const [status, setStatus] = useState(job.status);
  const [internalNotes, setInternalNotes] = useState(job.internalNotes || "");
  const [requestModalOpen, setRequestModalOpen] = useState(false);

  useEffect(() => {
    if (fetcher.data && "downloadUrl" in fetcher.data && fetcher.data.downloadUrl) {
      window.open(fetcher.data.downloadUrl as string, "_blank");
    }
    if (fetcher.data && "message" in fetcher.data && fetcher.data.message) {
      appBridge.toast.show(String(fetcher.data.message));
    }
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      appBridge.toast.show(String(fetcher.data.error), { isError: true });
    }
  }, [appBridge, fetcher.data]);

  return (
    <Page title={`Order ${job.shopifyOrderName}`} backAction={{ content: "Order jobs", url: "/app/orders" }}>
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                File Preview
              </Text>
              <Text as="p">{job.assetSnapshot?.originalName || "No file attached"}</Text>
              <Text as="p" tone="subdued">
                {(job.assetSnapshot?.widthInch || 0).toFixed(1)}&quot; x {(job.assetSnapshot?.heightInch || 0).toFixed(1)}
                &quot; | {job.assetSnapshot?.dpi || "N/A"} DPI
              </Text>
              <Text as="p" tone="subdued">
                {((job.assetSnapshot?.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB |{" "}
                {job.assetSnapshot?.fileExtension?.toUpperCase() || "N/A"}
              </Text>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="download" />
                <input type="hidden" name="storagePath" value={job.assetSnapshot?.storagePath || ""} />
                <Button submit disabled={!job.assetSnapshot?.storagePath}>
                  Download Original
                </Button>
              </fetcher.Form>
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
                <Text as="p">Customer: {job.customerEmail || "N/A"}</Text>
                <Text as="p">Product ID: {job.productId || "N/A"}</Text>
                <fetcher.Form method="post">
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
                        { label: "Ready for production", value: "ready_for_production" },
                        { label: "Re-upload requested", value: "reupload_requested" },
                      ]}
                      onChange={setStatus}
                    />
                    <Button submit>Save status</Button>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </Card>

            <Card>
              <fetcher.Form method="post">
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
              </fetcher.Form>
            </Card>

            <Card>
              <Button tone="critical" onClick={() => setRequestModalOpen(true)}>
                Request Re-upload
              </Button>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Audit History
              </Text>
              {audit.map((event) => (
                <Text as="p" key={event.id}>
                  {new Date(event.createdAt).toLocaleString()} - {event.message}
                </Text>
              ))}
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
            fetcher.submit({ intent: "request_reupload" }, { method: "post" });
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
