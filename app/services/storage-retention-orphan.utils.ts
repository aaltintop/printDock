import { MS_PER_HOUR } from "../config/storage-lifecycle";
import type { UploadSession } from "../types/printdock";

export function parseTimeMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function isOrderStoragePathPrefix(path: string, shopDomain: string): boolean {
  return path.startsWith(`uploads/${shopDomain}/orders/`);
}

/** Whether an entire session is eligible for orphan sweep at `nowMs`. */
export function shouldSweepSession(session: UploadSession, nowMs: number): boolean {
  if (session.status === "converted" || session.status === "expired") return false;

  const hasAssets =
    session.assets.length > 0 || Boolean(session.asset?.storagePath?.trim());

  if (
    session.status === "success" ||
    session.status === "blocked" ||
    (session.status === "active" && hasAssets)
  ) {
    return nowMs > parseTimeMs(session.expiresAt);
  }

  if (session.status === "active" && !hasAssets) {
    return nowMs > parseTimeMs(session.createdAt) + 2 * MS_PER_HOUR;
  }

  return false;
}

export function isPathProtectedFromOrphan(
  path: string,
  shopDomain: string,
  protectedPaths: ReadonlySet<string>,
): boolean {
  const trimmed = path.trim();
  if (!trimmed) return true;
  if (isOrderStoragePathPrefix(trimmed, shopDomain)) return true;
  return protectedPaths.has(trimmed);
}
