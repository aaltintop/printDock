/**
 * Merchant-facing changelog — short, benefit-focused. Bump `version` when you ship; newest first.
 */
export type ReleaseNoteEntry = {
  version: string;
  /** Shown as-is (e.g. `May 2026`). */
  date: string;
  /** One plain sentence — what improved for the merchant. */
  summary: string;
};

export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: "1.0.14",
    date: "May 2026",
    summary: "Simpler setup and smoother upload pricing at checkout.",
  },
  {
    version: "1.0.11",
    date: "May 2026",
    summary: "Order pages in Shopify Admin are cleaner and easier to read.",
  },
  {
    version: "1.0.8",
    date: "May 2026",
    summary: "Download customer uploads directly from the order — no copy and paste.",
  },
  {
    version: "1.0.5",
    date: "May 2026",
    summary: "Quick access to all uploaded files from the order page.",
  },
  {
    version: "1.0.2",
    date: "May 2026",
    summary: "Upload fees apply automatically; dynamic pricing works on every Shopify plan.",
  },
  {
    version: "1.0.0",
    date: "May 2026",
    summary: "PrintDock launch — upload fields, pricing, and orders in one place.",
  },
];

/** How many past releases to show on the Release notes page. */
export const RELEASE_NOTES_DISPLAY_LIMIT = 5;
