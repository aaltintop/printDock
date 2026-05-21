import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BlockStack, Card, Divider, Page, Text } from "@shopify/polaris";
import { MERCHANT_GLOSSARY_SECTIONS } from "../data/merchant-glossary";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    log.event("admin_page_view", { path: "/app/glossary" });
    return { sections: MERCHANT_GLOSSARY_SECTIONS };
  });
};

export default function GlossaryPage() {
  const { sections } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Glossary"
      subtitle="PrintDock terms used in Orders, Fields, and Setup"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <BlockStack gap="400">
        {sections.map((section) => (
          <Card key={section.id}>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {section.title}
              </Text>
              <Divider />
              <BlockStack gap="300">
                {section.entries.map((entry) => (
                  <BlockStack key={entry.term} gap="100">
                    <Text as="p" fontWeight="semibold">
                      {entry.term}
                    </Text>
                    <Text as="p" tone="subdued">
                      {entry.definition}
                    </Text>
                  </BlockStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}
