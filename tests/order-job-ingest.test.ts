import { describe, expect, it } from "vitest";
import {
  canApproveWorkflowStatus,
  displayAssetForJob,
  formatJobDimensions,
  isIngestInProgress,
  workflowStatusConflictsWithIngest,
} from "../app/utils/order-job-ingest";
import type { OrderJob, UploadAsset } from "../app/types/printdock";

const previewAsset: UploadAsset = {
  id: "preview",
  storagePath: "",
  originalName: "logo.png",
  mimeType: "image/png",
  fileExtension: "png",
  sizeBytes: 2048,
  widthPx: 100,
  heightPx: 100,
  dpi: 300,
  widthInch: 2,
  heightInch: 2,
  pageCount: null,
  validationResults: [],
  pricing: null,
  blocked: false,
};

function job(partial: Partial<OrderJob>): OrderJob {
  return {
    id: "1",
    shopDomain: "shop.myshopify.com",
    shopifyOrderId: "1",
    shopifyOrderName: "#1",
    shopifyLineItemId: "1",
    sessionId: "s",
    shippingAddress: null,
    productId: "",
    variantId: "",
    assetSnapshot: null,
    lineItemPropsSnapshot: [],
    calculatedPrice: 0,
    warnings: [],
    status: "uploaded",
    assignee: null,
    internalNotes: "",
    tags: [],
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

describe("order-job-ingest helpers", () => {
  it("detects ingest in progress", () => {
    expect(isIngestInProgress("pending")).toBe(true);
    expect(isIngestInProgress("processing")).toBe(true);
    expect(isIngestInProgress("complete")).toBe(false);
  });

  it("uses preview asset when snapshot missing", () => {
    const row = job({ ingestPreviewAsset: previewAsset, ingestStatus: "pending" });
    expect(displayAssetForJob(row)?.originalName).toBe("logo.png");
    expect(formatJobDimensions(displayAssetForJob(row))).toBe('2.0" × 2.0"');
  });

  it("prefers snapshot over preview when both exist", () => {
    const snap = { ...previewAsset, id: "snap", originalName: "order-logo.png" };
    const row = job({ assetSnapshot: snap, ingestPreviewAsset: previewAsset, ingestStatus: "complete" });
    expect(displayAssetForJob(row)?.originalName).toBe("order-logo.png");
  });

  it("blocks approve while ingest runs", () => {
    expect(canApproveWorkflowStatus({ ingestStatus: "pending" })).toBe(false);
    expect(canApproveWorkflowStatus({ ingestStatus: "complete" })).toBe(true);
    expect(canApproveWorkflowStatus({ ingestStatus: "failed" })).toBe(true);
  });

  it("flags approved + importing conflict", () => {
    expect(workflowStatusConflictsWithIngest("approved", "pending")).toBe(true);
    expect(workflowStatusConflictsWithIngest("approved", "complete")).toBe(false);
  });
});
