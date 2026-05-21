/**
 * Merchant-facing glossary shown in the embedded admin app (/app/glossary).
 * Developer terms live in docs/GLOSSARY.md only — do not surface that file in the app.
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

export const MERCHANT_GLOSSARY_SECTIONS: GlossarySection[] = [
  {
    id: "workflow",
    title: "Core workflow",
    entries: [
      {
        term: "Job (order job)",
        definition:
          "One uploaded artwork tied to one order line, with status, file, and notes — what you manage on the Orders page.",
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
          "A customer's upload on the product page before checkout; the file is held until the order is placed or the session expires.",
      },
      {
        term: "Upload widget",
        definition:
          "Storefront upload UI from the PrintDock Upload theme block on the product page.",
      },
      {
        term: "Upload file",
        definition:
          "The artwork a customer selected, with size, dimensions, DPI, and validation results.",
      },
      {
        term: "Production file",
        definition:
          "The copy of the upload saved on the job after checkout, ready for download and production.",
      },
      {
        term: "Artwork import",
        definition:
          "After checkout, PrintDock copies the customer's upload into order storage. Download is available when import completes.",
      },
      {
        term: "Job status",
        definition: "Workflow on a job: Uploaded, Pending review, or Approved.",
      },
      {
        term: "Internal notes",
        definition: "Merchant-only notes on a job; not shown to customers on the storefront.",
      },
      {
        term: "Audit History",
        definition:
          "Activity log on a job detail page — status changes, notes saved, and other updates.",
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
    ],
  },
  {
    id: "pricing",
    title: "Pricing",
    entries: [
      {
        term: "Dynamic pricing",
        definition:
          "Upload fee calculated from your file rules, combined with the product base price at checkout.",
      },
      {
        term: "Upload fee",
        definition:
          "PrintDock charge for the artwork per unit, before adding the variant base price.",
      },
      {
        term: "Cart Transform",
        definition:
          "Shopify checkout step you enable during setup so PrintDock can apply the calculated upload price on the order line.",
      },
      {
        term: "Part of",
        definition:
          "Label under the product line in checkout and Shopify Admin showing the upload component (e.g. Upload file).",
      },
      {
        term: "Pricing verification",
        definition:
          "Warning on a job when the amount charged at checkout may not match the upload price PrintDock calculated.",
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
          "Download link on the order line; each click gets a fresh secure file URL.",
      },
      {
        term: "Short link",
        definition:
          "Compact download URL on the order that always points to the stored artwork file.",
      },
      {
        term: "Storage expired",
        definition:
          "File removed by your plan's retention period; the job record remains but download is unavailable.",
      },
    ],
  },
];
