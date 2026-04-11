import { data, redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { verifyPrintReadyFileToken } from "../services/file-download-token.server";
import { getSignedDownloadUrlAttachment } from "../services/storage.server";

/**
 * App proxy GET: validates Shopify proxy + HMAC token, then redirects to a
 * short-lived Storage URL with Content-Disposition: attachment.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.SHOPIFY_API_SECRET || "";
  const token = new URL(request.url).searchParams.get("token") || "";
  const verified = verifyPrintReadyFileToken(token, secret);

  if (!verified || verified.shop !== session.shop) {
    return data({ error: "Invalid or expired link" }, { status: 403 });
  }

  try {
    const signedUrl = await getSignedDownloadUrlAttachment(
      verified.storagePath,
      verified.originalName,
      600,
    );
    return redirect(signedUrl);
  } catch (err) {
    console.error("print-ready file redirect error:", err);
    return data({ error: "Download unavailable" }, { status: 500 });
  }
}
