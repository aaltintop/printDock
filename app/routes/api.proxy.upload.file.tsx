import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { findJobByLegacySessionUploadPath } from "../services/shop-data.server";
import { verifyPrintReadyFileToken } from "../services/file-download-token.server";
import { fileExists, getSignedDownloadUrlAttachment } from "../services/storage.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

/**
 * App proxy GET: validates Shopify proxy + HMAC token, then redirects to a
 * short-lived Storage URL with Content-Disposition: attachment.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      return publicError("unauthorized", { status: 401 });
    }

    setLogShopDomain(session.shop);
    log.event("upload_file_download_requested", {});

    const secret = process.env.SHOPIFY_API_SECRET || "";
    const token = new URL(request.url).searchParams.get("token") || "";
    const verified = verifyPrintReadyFileToken(token, secret);

    if (!verified || verified.shop !== session.shop) {
      return publicError("link_invalid", { status: 403 });
    }

    let storagePath = verified.storagePath;
    let downloadName = verified.originalName;

    if (!(await fileExists(storagePath))) {
      const job = await findJobByLegacySessionUploadPath(session.shop, storagePath);
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
      return internalError("upload_file_redirect_failed", err, {
        logMeta: { storagePath },
      });
    }
  });
}
