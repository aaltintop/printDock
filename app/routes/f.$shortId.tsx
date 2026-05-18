import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { findJobByLegacySessionUploadPath } from "../services/shop-data.server";
import {
  fileExists,
  getSignedDownloadUrlAttachment,
} from "../services/storage.server";
import {
  isValidShortIdShape,
  lookupShortLink,
} from "../services/short-link.server";
import {
  log,
  runWithRequestContext,
  setLogShopDomain,
} from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

/**
 * App proxy GET `/apps/printdock/f/:shortId`.
 *
 * Verifies the Shopify app-proxy signature, resolves the short ID to its
 * stored `(shop, storagePath, originalName)` mapping, then 302 redirects
 * to a short-lived signed Storage URL with `Content-Disposition: attachment`.
 *
 * The short URL itself is permanent — only the redirect target is
 * short-lived — so the link in the order page never goes stale while the
 * underlying file exists.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      return publicError("unauthorized", { status: 401 });
    }

    const shopDomain = session.shop;
    setLogShopDomain(shopDomain);

    const shortId = String(params.shortId || "");
    log.event("short_link_download_requested", { shortId });

    if (!isValidShortIdShape(shortId)) {
      return publicError("link_invalid", { status: 400 });
    }

    const record = await lookupShortLink(shopDomain, shortId);
    if (!record) {
      return publicError("link_invalid", {
        status: 404,
        message: "This file is no longer available.",
      });
    }

    let storagePath = record.storagePath;
    let downloadName = record.originalName;

    if (!storagePath.startsWith(`uploads/${shopDomain}/`)) {
      return publicError("link_invalid", { status: 403 });
    }

    if (!(await fileExists(storagePath))) {
      const job = await findJobByLegacySessionUploadPath(shopDomain, storagePath);
      if (job?.assetSnapshot?.storagePath) {
        storagePath = job.assetSnapshot.storagePath;
        downloadName = job.assetSnapshot.originalName || downloadName;
      }
    }

    if (!(await fileExists(storagePath))) {
      return publicError("not_found", {
        status: 404,
        message: "This file is no longer available.",
      });
    }

    try {
      const signedUrl = await getSignedDownloadUrlAttachment(
        storagePath,
        downloadName,
        600,
      );
      return redirect(signedUrl);
    } catch (err) {
      return internalError("short_link_redirect_failed", err, {
        logMeta: { storagePath },
      });
    }
  });
}
