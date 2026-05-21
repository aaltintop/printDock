import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import {
  createCollectionIdResolver,
  getActiveFieldForProduct,
  getUploadField,
  getUploadSession,
  updateUploadSession,
} from "../services/shop-data.server";
import { revalidateSessionAssetsForVariant } from "../services/variant-dimension-validation.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

const schema = z.object({
  sessionToken: z.string().min(1),
  variantId: z.string().min(1),
});

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) {
        return publicError("unauthorized", { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) {
        return publicError("bad_request", { status: 400 });
      }

      const { sessionToken, variantId } = parsed.data;

      log.event("upload_revalidate_requested", { sessionToken, variantId });

      const sessionData = await getUploadSession(shopDomain, sessionToken);
      if (!sessionData) {
        return publicError("session_invalid", { status: 404 });
      }

      if (
        sessionData.status === "expired" ||
        new Date(sessionData.expiresAt).getTime() < Date.now()
      ) {
        return publicError("session_expired", { status: 410 });
      }

      const field =
        (sessionData.fieldId ? await getUploadField(shopDomain, sessionData.fieldId) : null) ??
        (await getActiveFieldForProduct(
          shopDomain,
          sessionData.productId,
          variantId,
          createCollectionIdResolver(),
        ));

      const currentAssets =
        sessionData.assets.length > 0
          ? sessionData.assets
          : sessionData.asset
            ? [sessionData.asset]
            : [];

      const { assets: updatedAssets, passCount, skipCount, failCount } =
        revalidateSessionAssetsForVariant(
          currentAssets,
          field,
          sessionData.productId,
          variantId,
        );

      const sessionBlocked = updatedAssets.some((asset) => asset.blocked);

      await updateUploadSession(shopDomain, sessionToken, {
        variantId,
        assets: updatedAssets,
        asset: updatedAssets[0] ?? null,
        status: sessionBlocked ? "blocked" : updatedAssets.length > 0 ? "success" : "active",
      });

      log.event("variant_revalidation_completed", {
        sessionToken,
        variantId,
        assetsCount: updatedAssets.length,
        passCount,
        skipCount,
        failCount,
        sessionBlocked,
      });

      return data({
        ok: true,
        variantId,
        assets: updatedAssets,
        sessionBlocked,
      });
    } catch (err) {
      return internalError("upload_revalidate_failed", err);
    }
  });
}
