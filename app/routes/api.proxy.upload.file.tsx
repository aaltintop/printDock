import { data, redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { findJobByLegacySessionUploadPath } from "../services/shop-data.server";
import { verifyPrintReadyFileToken } from "../services/file-download-token.server";
import { fileExists, getSignedDownloadUrlAttachment } from "../services/storage.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

/**
 * App proxy GET: validates Shopify proxy + HMAC token, then redirects to a
 * short-lived Storage URL with Content-Disposition: attachment.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      return data({ error: "Unauthorized" }, { status: 401 });
    }

    setLogShopDomain(session.shop);
    log.event("upload_file_download_requested", {});

    const secret = process.env.SHOPIFY_API_SECRET || "";
    const token = new URL(request.url).searchParams.get("token") || "";
    const verified = verifyPrintReadyFileToken(token, secret);

    if (!verified || verified.shop !== session.shop) {
      return data({ error: "Invalid or expired link" }, { status: 403 });
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
      return data({ error: "File not found" }, { status: 404 });
    }

    try {
      const signedUrl = await getSignedDownloadUrlAttachment(
        storagePath,
        downloadName,
        600,
      );
      return redirect(signedUrl);
    } catch (err) {
      log.error("upload_file_redirect_failed", err, { storagePath });
      return data({ error: "Download unavailable" }, { status: 500 });
    }
  });
}
