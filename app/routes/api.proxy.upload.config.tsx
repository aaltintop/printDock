import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getPlan } from "../config/plans";
import {
  createCollectionIdResolver,
  getActiveFieldForProduct,
  getEffectiveBillingPlan,
} from "../services/shop-data.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) {
        return data({ error: "Unauthorized" }, { status: 401 });
      }

      const shopDomain = session.shop;
      setLogShopDomain(shopDomain);

      const url = new URL(request.url);
      const productId = url.searchParams.get("productId") || "";
      const variantId = url.searchParams.get("variantId") || "";
      if (!productId) {
        return data({ error: "Missing productId" }, { status: 400 });
      }

      log.event("upload_config_requested", { productId, variantId });

      const resolveCollectionIds = createCollectionIdResolver();
      const field = await getActiveFieldForProduct(
        shopDomain,
        productId,
        variantId,
        resolveCollectionIds,
      );
      const billingPlan = await getEffectiveBillingPlan(shopDomain);
      const planLimits = getPlan(billingPlan.planCode);

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
            usageThisMonth: billingPlan.usageThisMonth,
            maxOrdersPerMonth: planLimits.maxOrdersPerMonth,
          },
          planLimits: planLimitsResponse,
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
          fileQuantityManagement: field.fileQuantityManagement,
          pricing: field.pricing,
          dimensionRules: field.dimensionRules,
          planRequirement: field.planRequirement,
          fileRenamingPattern: field.fileRenamingPattern,
        },
        billingPlan: {
          planCode: billingPlan.planCode,
          usageThisMonth: billingPlan.usageThisMonth,
          maxOrdersPerMonth: planLimits.maxOrdersPerMonth,
        },
        planLimits: planLimitsResponse,
      });
    } catch (err) {
      log.error("upload_config_failed", err, {});
      throw err;
    }
  });
}
