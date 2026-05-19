import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { canUseFeature, getPlan } from "../config/plans";
import { inferCurrencyDecimals } from "../services/currency.server";
import {
  createCollectionIdResolver,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
} from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";
import { internalError, publicError } from "../lib/api-error.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) {
        return publicError("unauthorized", { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const url = new URL(request.url);
      const productId = url.searchParams.get("productId") || "";
      const variantId = url.searchParams.get("variantId") || "";
      if (!productId) {
        return publicError("bad_request", { status: 400 });
      }

      log.event("upload_config_requested", { productId, variantId });

      const { admin } = await unauthenticated.admin(shopDomain);
      const currencyRes = await admin.graphql(`#graphql
        query PrintDockUploadConfigShopCurrency {
          shop {
            currencyCode
          }
        }
      `);
      const currencyJson = await currencyRes.json();
      const shopCurrencyCode = String(currencyJson?.data?.shop?.currencyCode || "USD").toUpperCase() || "USD";
      const shopCurrencyDecimals = inferCurrencyDecimals(shopCurrencyCode);

      const resolveCollectionIds = createCollectionIdResolver();
      const field = await getActiveFieldForProduct(
        shopDomain,
        productId,
        variantId,
        resolveCollectionIds,
      );
      const billingPlan = await getEffectiveBillingPlan(shopDomain);
      const planLimits = getPlan(billingPlan.planCode);
      const planAllowsDynamicPricing = canUseFeature(billingPlan.planCode, "dynamicPricing");

      const planLimitsResponse = {
        maxFileSizeBytes: planLimits.maxFileSizeBytes,
        basicValidation: planLimits.basicValidation,
        advancedValidation: planLimits.advancedValidation,
        dynamicPricing: planLimits.dynamicPricing,
      };

      if (!field) {
        return data({
          field: null,
          defaults: {
            allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
            maxFileMB: Math.floor(planLimits.maxFileSizeBytes / (1024 * 1024)),
            minFiles: 1,
            maxFiles: 1,
          },
          billingPlan: {
            planCode: billingPlan.planCode,
          },
          planLimits: planLimitsResponse,
          shopCurrency: {
            code: shopCurrencyCode,
            decimals: shopCurrencyDecimals,
          },
        });
      }

      const fieldMaxBytes = field.maxFileMB * 1024 * 1024;
      const effectiveMaxMB = Math.floor(
        Math.min(fieldMaxBytes, planLimits.maxFileSizeBytes) / (1024 * 1024),
      );

      return data({
        field: {
          id: field.id,
          isRequired: field.isRequired,
          storefrontTitle: field.storefrontTitle,
          storefrontDescription: field.storefrontDescription,
          allowedExtensions: field.allowedExtensions,
          maxFileMB: effectiveMaxMB,
          minFiles: field.minFiles,
          maxFiles: field.maxFiles,
          pricing: planAllowsDynamicPricing
            ? field.pricing
            : { ...field.pricing, enabled: false },
          dimensionRules: field.dimensionRules,
          planRequirement: field.planRequirement,
          fileRenamingPattern: field.fileRenamingPattern,
        },
        billingPlan: {
          planCode: billingPlan.planCode,
        },
        planLimits: planLimitsResponse,
        shopCurrency: {
          code: shopCurrencyCode,
          decimals: shopCurrencyDecimals,
        },
        /** @deprecated Build A — no separate fee variant; always null. */
        feeVariantId: null,
      });
    } catch (err) {
      return internalError("upload_config_failed", err);
    }
  });
}
