import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { deleteFile } from "../services/storage.server";
import {
  adjustShopStorageUsageBytes,
  getUploadSession,
  isBillableStorageAsset,
  sessionAssetsCollection,
  sessionsCollection,
  updateUploadSession,
} from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

const schema = z.object({
  sessionToken: z.string().min(1),
  storagePath: z.string().min(1),
});

function isSafeSessionStoragePath(path: string, shopDomain: string, sessionToken: string): boolean {
  const prefix = `uploads/${shopDomain}/${sessionToken}/`;
  return path.startsWith(prefix) && !path.includes("..");
}

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

      const { sessionToken, storagePath } = parsed.data;
      if (!isSafeSessionStoragePath(storagePath, shopDomain, sessionToken)) {
        return publicError("forbidden", { status: 403 });
      }

      const sessionData = await getUploadSession(shopDomain, sessionToken);
      if (sessionData?.status === "converted") {
        return publicError("already_ordered", { status: 409 });
      }

      await deleteFile(storagePath);

      if (!sessionData) {
        log.event("upload_removed_without_session", {
          sessionToken,
          storagePath,
        });
        return data({ deleted: true, sessionDeleted: false });
      }

      const currentAssets =
        sessionData.assets.length > 0
          ? sessionData.assets
          : sessionData.asset
            ? [sessionData.asset]
            : [];
      const removedAssets = currentAssets.filter((asset) => asset.storagePath === storagePath);
      const nextAssets = currentAssets.filter((asset) => asset.storagePath !== storagePath);
      const bytesFreed = removedAssets.reduce((sum, asset) => sum + Number(asset.sizeBytes || 0), 0);
      const billableBytesFreed = removedAssets
        .filter(isBillableStorageAsset)
        .reduce((sum, asset) => sum + Number(asset.sizeBytes || 0), 0);

      const assetsCol = sessionAssetsCollection(shopDomain, sessionToken);
      const deleteById = removedAssets
        .filter((asset) => asset.id)
        .map((asset) => assetsCol.doc(asset.id).delete());
      await Promise.all(deleteById);

      const matchedAssetsSnap = await assetsCol.where("storagePath", "==", storagePath).get();
      if (!matchedAssetsSnap.empty) {
        await Promise.all(matchedAssetsSnap.docs.map((doc) => doc.ref.delete()));
      }

      if (nextAssets.length === 0) {
        const remainingAssetsSnap = await assetsCol.get();
        if (!remainingAssetsSnap.empty) {
          await Promise.all(remainingAssetsSnap.docs.map((doc) => doc.ref.delete()));
        }
        await sessionsCollection(shopDomain).doc(sessionToken).delete();
        if (billableBytesFreed > 0) {
          await adjustShopStorageUsageBytes(shopDomain, -billableBytesFreed);
        }
        log.event("upload_removed", {
          sessionToken,
          storagePath,
          bytesFreed,
          sessionDeleted: true,
        });
        return data({ deleted: true, sessionDeleted: true });
      }

      await updateUploadSession(shopDomain, sessionToken, {
        assets: nextAssets,
        asset: nextAssets[0] ?? null,
        status: nextAssets.some((asset) => asset.blocked) ? "blocked" : "success",
      });

      if (billableBytesFreed > 0) {
        await adjustShopStorageUsageBytes(shopDomain, -billableBytesFreed);
      }

      log.event("upload_removed", {
        sessionToken,
        storagePath,
        bytesFreed,
        sessionDeleted: false,
      });
      return data({ deleted: true, sessionDeleted: false });
    } catch (err) {
      return internalError("upload_remove_failed", err);
    }
  });
}
