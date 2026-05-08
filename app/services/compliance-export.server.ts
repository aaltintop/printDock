import {
  getUploadSession,
  listOrderJobsByShopifyOrderIds,
  shopDoc,
} from "./shop-data.server";
import { saveTextObject } from "./storage.server";
import type { UploadSession } from "../types/printdock";

export interface CustomerDataRequestInput {
  shopDomain: string;
  ordersRequested: number[];
  customer: { id?: number; email?: string; phone?: string | number };
  dataRequest: { id?: number };
}

export interface CustomerDataRequestExportResult {
  storagePath: string;
  jobCount: number;
  uploadSessionCount: number;
  firestoreDocId: string;
}

function complianceExportObjectPath(shopDomain: string, dataRequestKey: string): string {
  const safe = dataRequestKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `compliance/${shopDomain}/data_requests/${safe}_${ts}.json`;
}

/**
 * Builds a JSON export of PrintDock-held data for the given Shopify customer data request,
 * writes it to Cloud Storage (outside `uploads/` — not subject to upload retention rules),
 * and records a Firestore row under `shops/{shop}/compliance_data_requests/{id}` for staff lookup.
 */
export async function createCustomerDataRequestExport(
  input: CustomerDataRequestInput,
): Promise<CustomerDataRequestExportResult> {
  const { shopDomain, ordersRequested, customer, dataRequest } = input;

  const dataRequestKey =
    dataRequest?.id != null && Number.isFinite(Number(dataRequest.id))
      ? String(dataRequest.id)
      : `noid_${Date.now()}`;

  const orderJobs = await listOrderJobsByShopifyOrderIds(shopDomain, ordersRequested);
  const sessionIds = [
    ...new Set(
      orderJobs.map((j) => j.sessionId).filter((s) => typeof s === "string" && s.trim() !== ""),
    ),
  ];

  const linkedUploadSessions: Array<{ sessionId: string; session: UploadSession | null }> = [];
  for (const sessionId of sessionIds) {
    const session = await getUploadSession(shopDomain, sessionId);
    linkedUploadSessions.push({ sessionId, session });
  }

  const packageJson = {
    meta: {
      generatedAt: new Date().toISOString(),
      shopDomain,
      shopifyDataRequestId: dataRequest?.id ?? null,
      shopifyCustomerId: customer?.id ?? null,
      customerEmail: customer?.email ?? null,
      customerPhone: customer?.phone != null ? String(customer.phone) : null,
      ordersRequested,
      app: "PrintDock",
      schemaVersion: 1,
    },
    orderJobs,
    linkedUploadSessions,
    note:
      "Share this JSON with the merchant to help them respond to the customer data request. " +
      "Design files remain in storage at paths referenced on jobs and sessions; this export is the structured data PrintDock stores (order jobs, line item properties, upload session metadata).",
  };

  const body = JSON.stringify(packageJson, null, 2);
  const storagePath = complianceExportObjectPath(shopDomain, dataRequestKey);
  await saveTextObject(storagePath, body);

  const firestoreDocId = dataRequestKey.slice(0, 1400);
  await shopDoc(shopDomain)
    .collection("compliance_data_requests")
    .doc(firestoreDocId)
    .set(
      {
        type: "customers_data_request",
        shopifyDataRequestId: dataRequest?.id ?? null,
        shopifyCustomerId: customer?.id ?? null,
        ordersRequested: ordersRequested.map(String),
        storagePath,
        jobCount: orderJobs.length,
        uploadSessionCount: sessionIds.length,
        createdAt: new Date().toISOString(),
      },
      { merge: true },
    );

  return {
    storagePath,
    jobCount: orderJobs.length,
    uploadSessionCount: sessionIds.length,
    firestoreDocId,
  };
}
