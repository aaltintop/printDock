/**
 * Merchant-facing changelog (plain language — what store owners notice, not how it’s built).
 * Bump `version` when you ship; keep newest first.
 */
export type ReleaseNoteEntry = {
  version: string;
  /** Shown as-is (e.g. `2026-05-13` or `May 2026`). */
  date: string;
  highlights: string[];
};

export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: "1.0.6",
    date: "2026-05-18",
    highlights: [
      "Print Ready File is now a short, clickable link directly inside the order's line item card — no copy/paste, no block to pin.",
      "Each click resolves to a freshly signed download URL, so links stay permanent in the order but the underlying storage URL never goes stale.",
      "More actions → PrintDock files opens a panel listing every upload on the order with a Download button per file.",
    ],
  },
  {
    version: "1.0.5",
    date: "2026-05-18",
    highlights: [
      "New PrintDock block on the order page in Shopify Admin shows uploaded files with a one-tap Download button.",
      "No more copying long links from order properties — open or save artwork directly from the order.",
    ],
  },
  {
    version: "1.0.4",
    date: "2026-05-18",
    highlights: [
      "Order line items are cleaner: internal dynamic-pricing tokens are no longer shown per uploaded item.",
      "Print Ready File remains visible so merchants and customers can open and download artwork directly.",
      "Dynamic upload pricing still works by using secure cart-level pricing proof in the background.",
    ],
  },
  {
    version: "1.0.3",
    date: "2026-05-18",
    highlights: [
      "Cleaner orders in Shopify Admin — uploaded file names appear as Artwork without extra links cluttering the line item.",
      "When a customer orders more than one of the same item, each upload job uses the quantity they chose at checkout.",
    ],
  },
  {
    version: "1.0.2",
    date: "2026-05-18",
    highlights: [
      "Upload fees are added automatically at checkout — no need for a separate hidden product in your catalog.",
      "Dynamic upload pricing works on all Shopify plans, not only Plus.",
      "After a customer adds their design to the cart, the upload area resets so they can start another item easily.",
      "The price on the product page stays in sync when they switch variants (for example, size or color).",
      "If pricing on an order looks off, the order job page will call it out so you can review it.",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-05-14",
    highlights: [
      "Bug fixes and small improvements for a smoother day-to-day experience.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-05-13",
    highlights: [
      "See what’s new in PrintDock from this Release notes page in your admin.",
      "Check which app version is running for your store.",
    ],
  },
];
