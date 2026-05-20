/**
 * In-app glossary entries. Keep in sync with docs/GLOSSARY.md (source of truth for developers).
 */

export type GlossaryEntry = {
  term: string;
  definition: string;
};

export type GlossarySection = {
  id: string;
  title: string;
  entries: GlossaryEntry[];
};

export const GLOSSARY_SECTIONS: GlossarySection[] = [
  {
    id: "workflow",
    title: "Core workflow",
    entries: [
      {
        term: "Job (order job)",
        definition:
          "One uploaded artwork tied to one order line, with status, file snapshot, and notes — what you manage on the Orders page.",
      },
      {
        term: "Order Jobs page",
        definition:
          "The in-app Orders list; each row is one job, not every order in Shopify Admin.",
      },
      {
        term: "Shopify order",
        definition:
          "The full order in Shopify Admin; one order can have zero, one, or many PrintDock jobs (one per line with an upload).",
      },
      {
        term: "Field (upload field)",
        definition:
          "Configuration for which products get an upload widget, file rules, dimension checks, and optional dynamic pricing.",
      },
      {
        term: "Upload session",
        definition:
          "Customer upload in progress on the product page before checkout, keyed by a session token.",
      },
      {
        term: "Upload widget",
        definition:
          "Storefront upload UI from the PrintDock Upload theme block on the product page.",
      },
      {
        term: "Asset (upload asset)",
        definition:
          "One uploaded file with metadata (size, dimensions, DPI, validation, optional price).",
      },
      {
        term: "Asset snapshot",
        definition:
          "File and metadata stored on a job after checkout, for production and download.",
      },
      {
        term: "Order ingest",
        definition:
          "Server process after checkout that copies artwork into order storage and completes the job file.",
      },
      {
        term: "Audit event",
        definition:
          "One activity log line on a job (status changes, ingest finished, notes saved).",
      },
      {
        term: "Job status",
        definition:
          "Workflow on a job: Uploaded, Pending review, or Approved.",
      },
      {
        term: "Ingest status",
        definition:
          "Whether artwork import is pending, processing, complete, or failed.",
      },
    ],
  },
  {
    id: "storefront",
    title: "Storefront",
    entries: [
      {
        term: "PrintDock Upload (theme block)",
        definition:
          "Product-page block in the theme editor; customers upload files before add to cart.",
      },
      {
        term: "Session token",
        definition:
          "ID on the cart line (_uc_session) linking upload, checkout, and the order job.",
      },
      {
        term: "Converted session",
        definition: "Upload tied to a completed order; file kept for production.",
      },
    ],
  },
  {
    id: "pricing",
    title: "Cart and pricing",
    entries: [
      {
        term: "Dynamic pricing",
        definition:
          "Upload fee from file rules plus product base price, applied at checkout.",
      },
      {
        term: "Upload fee",
        definition:
          "PrintDock charge for the artwork per unit, before adding the variant base price.",
      },
      {
        term: "Cart Transform",
        definition:
          "Shopify Function that sets the checkout line price from your signed upload price (one line per upload).",
      },
      {
        term: "Price map",
        definition:
          "Cart attribute (_pd_price_map) holding signed prices per upload session for checkout.",
      },
      {
        term: "Part of",
        definition:
          "Checkout/Admin label under the product line showing the upload component (e.g. Upload file).",
      },
      {
        term: "Pricing anomaly",
        definition:
          "Warning on a job when checkout did not match a valid signed upload price.",
      },
      {
        term: "Build A",
        definition: "Current model: one cart line per upload with combined price at checkout.",
      },
      {
        term: "Build B (legacy)",
        definition:
          "Older two-line cart (product + fee line); only relevant for old open carts.",
      },
    ],
  },
  {
    id: "downloads",
    title: "Downloads",
    entries: [
      {
        term: "View uploads / Print Ready File",
        definition:
          "Short download link on the order line; each click gets a fresh secure file URL.",
      },
      {
        term: "Short link",
        definition:
          "Permanent short URL on the order that points to the stored artwork file.",
      },
      {
        term: "Storage expired",
        definition:
          "File removed by retention; job record remains but download is unavailable.",
      },
    ],
  },
];
