import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readRootPackageVersion(): string {
  try {
    const raw = readFileSync(join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    const v = pkg.version;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type ReleaseInfo = {
  /** Version embedded with the admin UI + default API semver. */
  appVersion: string;
  /** Backend/API semver — override in production when API outpaces UI. */
  backendVersion: string;
  /** Opaque deploy id (Git SHA, Cloud Run revision, CI build number). */
  buildId: string | null;
  /** Optional human deploy label (e.g. ISO time from CI). */
  deployedAt: string | null;
  nodeEnv: string;
};

/**
 * Release metadata for the currently running Cloud Run / Node process.
 * Set `PRINTDOCK_BACKEND_VERSION` when the API rollout differs from `package.json`.
 * Set `PRINTDOCK_BUILD_ID` (and optionally `PRINTDOCK_DEPLOYED_AT`) from CI/CD.
 */
export function getReleaseInfo(): ReleaseInfo {
  const appVersion = readRootPackageVersion();
  const backendVersion =
    typeof process.env.PRINTDOCK_BACKEND_VERSION === "string" &&
    process.env.PRINTDOCK_BACKEND_VERSION.trim() !== ""
      ? process.env.PRINTDOCK_BACKEND_VERSION.trim()
      : appVersion;

  const buildId =
    typeof process.env.PRINTDOCK_BUILD_ID === "string" && process.env.PRINTDOCK_BUILD_ID.trim() !== ""
      ? process.env.PRINTDOCK_BUILD_ID.trim()
      : typeof process.env.K_REVISION === "string" && process.env.K_REVISION.trim() !== ""
        ? process.env.K_REVISION.trim()
        : typeof process.env.GITHUB_SHA === "string" && process.env.GITHUB_SHA.length >= 7
          ? process.env.GITHUB_SHA.slice(0, 12)
          : null;

  const deployedAt =
    typeof process.env.PRINTDOCK_DEPLOYED_AT === "string" &&
    process.env.PRINTDOCK_DEPLOYED_AT.trim() !== ""
      ? process.env.PRINTDOCK_DEPLOYED_AT.trim()
      : null;

  return {
    appVersion,
    backendVersion,
    buildId,
    deployedAt,
    nodeEnv: process.env.NODE_ENV || "development",
  };
}
