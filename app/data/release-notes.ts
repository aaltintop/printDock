/** Merchant-facing changelog. Bump `version` when you ship; keep newest first. */
export type ReleaseNoteEntry = {
  version: string;
  /** Shown as-is (e.g. `2026-05-13` or `May 2026`). */
  date: string;
  highlights: string[];
};

export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: "1.0.1",
    date: "2026-05-14",
    highlights: [
      "Patch release with bug fixes and small improvements.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-05-13",
    highlights: [
      "Release notes and version page in the app admin.",
      "Shows the admin UI version, API/backend version, and deploy build id when configured.",
    ],
  },
];
