import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate, unauthenticated } from "../shopify.server";
import { ensureHmacSecret } from "../services/shop-secret.server";
import { defaultTokenTtlSeconds, signPriceToken } from "../services/price-token.server";
import { getUploadSession } from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

const schema = z.object({
  sessionToken: z.string().min(1),
  priceMinorUnits: z.number().int().min(0),
  pricingMode: z.enum(["buildB", "legacy"]).optional(),
});

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

async function fetchShopCurrencyCode(admin: AdminLike): Promise<string> {
  const res = await admin.graphql(`#graphql
    query PrintDockShopCurrency {
      shop {
        currencyCode
      }
    }
  `);
  const json = await res.json();
  const code = String(json?.data?.shop?.currencyCode || "USD").toUpperCase();
  return code || "USD";
}

export async function action({ request }: ActionFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      if (request.method !== "POST") {
        return publicError("method_not_allowed", { status: 405 });
      }

      const { session } = await authenticate.public.appProxy(request);
      if (!session) {
        return publicError("unauthorized", { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return publicError("bad_request", { status: 400 });
      }

      const { sessionToken, priceMinorUnits, pricingMode } = parsed.data;

      const uploadSession = await getUploadSession(shopDomain, sessionToken);
      if (!uploadSession) {
        return publicError("session_invalid", { status: 404 });
      }

      const { admin } = await unauthenticated.admin(shopDomain);
      const currencyCode = await fetchShopCurrencyCode(admin);
      const { hmacKey } = await ensureHmacSecret(admin, shopDomain);

      const now = Math.floor(Date.now() / 1000);
      const exp = now + defaultTokenTtlSeconds();
      const token = signPriceToken(
        {
          shop: shopDomain,
          sid: sessionToken,
          p: priceMinorUnits,
          c: currencyCode,
          exp,
          iat: now,
          mode: pricingMode,
        },
        hmacKey,
      );

      log.event("upload_price_token_signed", { shopDomain, sessionToken });
      return data({ token, expiresAt: exp });
    } catch (err) {
      return internalError("upload_sign_failed", err);
    }
  });
}
