import { useEffect } from "react";
import { data, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  BlockStack,
  Card,
  InlineStack,
  Page,
  Spinner,
  Text,
} from "@shopify/polaris";

import {
  getAppAdminHandle,
  getManagedPricingPlanSelectionUrl,
} from "../config/billing";
import { authenticate } from "../shopify.server";
import {
  log,
  runWithRequestContext,
  setLogShopDomain,
} from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    const managedPricingUrl = getManagedPricingPlanSelectionUrl(
      session.shop,
      getAppAdminHandle(),
    );
    log.event("plans_redirect_to_shopify", { url: managedPricingUrl });
    return data({ managedPricingUrl });
  });
};

export default function PlansPage() {
  const { managedPricingUrl } = useLoaderData<typeof loader>();
  useEffect(() => {
    window.open(managedPricingUrl, "_top");
  }, [managedPricingUrl]);

  return (
    <Page title="Plans">
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="center">
            <Spinner
              accessibilityLabel="Opening Shopify plan selection"
              size="small"
            />
            <Text as="p">Opening Shopify plan selection…</Text>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            If nothing happens,{" "}
            <a href={managedPricingUrl} target="_top" rel="noopener noreferrer">
              open it directly
            </a>
            .
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
