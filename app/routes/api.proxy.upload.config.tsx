import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getActiveFieldForProduct, getEffectiveBillingPlan } from "../services/shop-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  const shopDomain = session.shop;
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") || "";
  const variantId = url.searchParams.get("variantId") || "";
  if (!productId) {
    return data({ error: "Missing productId" }, { status: 400 });
  }

  const field = await getActiveFieldForProduct(shopDomain, productId, variantId);
  const billingPlan = await getEffectiveBillingPlan(shopDomain);
  if (!field) {
    return data({
      field: null,
      defaults: {
        allowedExtensions: ["png", "jpg", "jpeg", "pdf"],
        maxFileMB: 50,
        minFiles: 1,
        maxFiles: 1,
      },
      billingPlan: {
        planCode: billingPlan.planCode,
        usageThisMonth: billingPlan.usageThisMonth,
        monthlyUploadsLimit: billingPlan.monthlyUploadsLimit,
      },
    });
  }

  return data({
    field: {
      id: field.id,
      isRequired: field.isRequired,
      storefrontTitle: field.storefrontTitle,
      storefrontDescription: field.storefrontDescription,
      allowedExtensions: field.allowedExtensions,
      maxFileMB: field.maxFileMB,
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
      monthlyUploadsLimit: billingPlan.monthlyUploadsLimit,
    },
  });
}

