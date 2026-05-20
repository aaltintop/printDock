import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { RELEASE_NOTES } from "../data/release-notes";
import { getReleaseInfo } from "../lib/release-info.server";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    log.event("admin_page_view", { path: "/app/release-notes" });

    return {
      shop: session.shop,
      release: getReleaseInfo(),
      releaseNotes: RELEASE_NOTES,
    };
  });
};

export default function ReleaseNotesPage() {
  const { shop, release, releaseNotes } = useLoaderData<typeof loader>();

  return (
    <Page title="Release notes" subtitle="What’s running for your store">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Installed release (this session)
            </Text>
            <Text as="p" tone="subdued">
              Your staff sees the admin below; API and theme extension builds follow your developer’s
              deploy process. Cart Transform and app extensions update when a new app version is
              released in the Partner Dashboard (<code>shopify app deploy</code>).
            </Text>
            <Divider />
            <BlockStack gap="150">
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  Store:{" "}
                </Text>
                {shop}
              </Text>
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  Admin UI:{" "}
                </Text>
                v{release.appVersion}
              </Text>
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  API / backend:{" "}
                </Text>
                v{release.backendVersion}
              </Text>
              {release.appVersion !== release.backendVersion ? (
                <Text as="p" tone="subdued">
                  Admin UI and API versions differ — expected if the API was deployed separately.
                </Text>
              ) : null}
              {release.buildId ? (
                <Text as="p">
                  <Text as="span" fontWeight="semibold">
                    Build:{" "}
                  </Text>
                  <code>{release.buildId}</code>
                </Text>
              ) : (
                <Text as="p" tone="subdued">
                  Build id not set — add <code>PRINTDOCK_BUILD_ID</code> (or use Cloud Run{" "}
                  <code>K_REVISION</code>) in production for support.
                </Text>
              )}
              {release.deployedAt ? (
                <Text as="p">
                  <Text as="span" fontWeight="semibold">
                    Deployed:{" "}
                  </Text>
                  {release.deployedAt}
                </Text>
              ) : null}
              <Text as="p" tone="subdued">
                Runtime: {release.nodeEnv}
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Terminology
            </Text>
            <Text as="p" tone="subdued">
              <strong>Job</strong> = one uploaded artwork on one order line (Orders page).{" "}
              <strong>Field</strong> = upload rules for products.{" "}
              <strong>Session</strong> = customer upload before checkout.
            </Text>
            <Button url="/app/glossary">Open full glossary</Button>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Latest changes
            </Text>
            <Text as="p" tone="subdued">
              High-level summary. Full App Store listing updates appear on the Shopify App Store when
              published.
            </Text>
            <Divider />
            <BlockStack gap="400">
              {releaseNotes.map((entry) => (
                <BlockStack key={entry.version} gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      v{entry.version}
                    </Text>
                    <Text as="span" tone="subdued">
                      {entry.date}
                    </Text>
                  </InlineStack>
                  <List>
                    {entry.highlights.map((line, i) => (
                      <List.Item key={i}>{line}</List.Item>
                    ))}
                  </List>
                </BlockStack>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
