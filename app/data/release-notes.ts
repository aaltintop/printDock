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
