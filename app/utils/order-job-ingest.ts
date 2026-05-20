import type { OrderJob, UploadAsset } from "../types/printdock";

export type IngestStatus = NonNullable<OrderJob["ingestStatus"]>;

export function isIngestInProgress(ingestStatus?: OrderJob["ingestStatus"]): boolean {
  return ingestStatus === "pending" || ingestStatus === "processing";
}

export function isIngestComplete(ingestStatus?: OrderJob["ingestStatus"]): boolean {
  return ingestStatus === "complete";
}

/** Asset shown in lists/detail: finalized snapshot, else pre-ingest session preview. */
export function displayAssetForJob(job: Pick<OrderJob, "assetSnapshot" | "ingestPreviewAsset">): UploadAsset | null {
  if (job.assetSnapshot) return job.assetSnapshot;
  return job.ingestPreviewAsset ?? null;
}

export function formatJobDimensions(asset: UploadAsset | null | undefined): string {
  if (asset?.widthInch && asset?.heightInch) {
    return `${asset.widthInch.toFixed(1)}" × ${asset.heightInch.toFixed(1)}"`;
  }
  return "N/A";
}

export function ingestFileColumnLabel(ingestStatus?: OrderJob["ingestStatus"]): string | null {
  if (ingestStatus === "pending" || ingestStatus === "processing") return "Artwork importing…";
  if (ingestStatus === "failed") return null;
  return null;
}

export function canApproveWorkflowStatus(job: Pick<OrderJob, "ingestStatus">): boolean {
  return isIngestComplete(job.ingestStatus) || job.ingestStatus === "failed";
}

export function workflowStatusConflictsWithIngest(
  workflowStatus: string,
  ingestStatus?: OrderJob["ingestStatus"],
): boolean {
  const normalized = workflowStatus === "ready_for_production" ? "approved" : workflowStatus;
  return normalized === "approved" && isIngestInProgress(ingestStatus);
}
