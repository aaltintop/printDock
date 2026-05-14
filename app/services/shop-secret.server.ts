import { randomBytes } from "crypto";
import { db } from "../firebase.server";
import { log } from "../lib/logger.server";

const SECRETS_DOC = "secrets";
const SYSTEM_COLLECTION = "system";

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

function secretsDocRef(shopDomain: string) {
  return db.collection("shops").doc(shopDomain).collection(SYSTEM_COLLECTION).doc(SECRETS_DOC);
}

async function fetchShopGid(admin: AdminLike): Promise<string> {
  const res = await admin.graphql(`#graphql
    query PrintDockShopGid {
      shop { id }
    }
  `);
  const json = await res.json();
  const id = String(json?.data?.shop?.id || "");
  if (!id) throw new Error("Could not resolve shop GID for metafield write");
  return id;
}

/**
 * Ensures a per-shop HMAC key exists in Firestore and is mirrored to the shop
 * metafield `hmac_secret` (app namespace via metafieldsSet — omit namespace to
 * use $app). Also mirrored onto the Cart Transform owner during registration so the
 * function input query can read `cartTransform.pricingHmac`.
 */
export async function ensureHmacSecret(
  admin: AdminLike,
  shopDomain: string,
): Promise<{ hmacKey: string }> {
  const ref = secretsDocRef(shopDomain);
  const snap = await ref.get();
  const existing = snap.exists ? String((snap.data() as { hmacKey?: string })?.hmacKey || "") : "";

  let hmacKey = existing;
  if (!hmacKey || hmacKey.length < 32) {
    hmacKey = randomBytes(32).toString("base64url");
    await ref.set({ hmacKey, updatedAt: new Date().toISOString() }, { merge: true });
    log.event("shop_hmac_secret_generated", { shopDomain });
  }

  const shopGid = await fetchShopGid(admin);
  const setRes = await admin.graphql(
    `#graphql
    mutation PrintDockSetShopHmacMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopGid,
            key: "hmac_secret",
            type: "single_line_text_field",
            value: hmacKey,
          },
          {
            ownerId: shopGid,
            namespace: "printdock",
            key: "hmac_secret",
            type: "single_line_text_field",
            value: hmacKey,
          },
        ],
      },
    },
  );
  const setJson = await setRes.json();
  const userErrors = Array.isArray(setJson?.data?.metafieldsSet?.userErrors)
    ? setJson.data.metafieldsSet.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = String(userErrors[0]?.message || "metafieldsSet failed");
    log.error("shop_hmac_metafield_set_failed", new Error(msg), { shopDomain });
    throw new Error(`Could not mirror HMAC secret to shop metafield: ${msg}`);
  }

  return { hmacKey };
}

export async function getHmacSecretFromFirestore(shopDomain: string): Promise<string | null> {
  const snap = await secretsDocRef(shopDomain).get();
  if (!snap.exists) return null;
  const key = String((snap.data() as { hmacKey?: string })?.hmacKey || "");
  return key.length >= 32 ? key : null;
}

/**
 * Mirrors the pricing HMAC onto the active Cart Transform owner so the WASM input
 * query can read `cartTransform { metafield(...) }` (recommended in Shopify examples).
 * Shop metafields alone are not always visible to Cart Transform function input.
 */
export async function mirrorHmacSecretToCartTransformOwner(
  admin: AdminLike,
  cartTransformGid: string,
  hmacKey: string,
): Promise<{ ok: boolean; message: string | null }> {
  const owner = String(cartTransformGid || "").trim();
  const value = String(hmacKey || "").trim();
  if (!owner || !value) return { ok: true, message: null };

  const setRes = await admin.graphql(
    `#graphql
    mutation PrintDockMirrorHmacToCartTransform($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: owner,
            key: "hmac_secret",
            type: "single_line_text_field",
            value,
          },
        ],
      },
    },
  );
  const setJson = await setRes.json();
  const userErrors = Array.isArray(setJson?.data?.metafieldsSet?.userErrors)
    ? setJson.data.metafieldsSet.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = String(userErrors[0]?.message || "metafieldsSet failed");
    log.warn("cart_transform_hmac_mirror_user_error", msg, { owner });
    return { ok: false, message: msg };
  }
  log.event("cart_transform_hmac_mirrored", { owner });
  return { ok: true, message: null };
}
