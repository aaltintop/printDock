import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BlockStack, Card, Divider, InlineStack, Page, Text } from "@shopify/polaris";
import { RELEASE_NOTES, RELEASE_NOTES_DISPLAY_LIMIT } from "../data/release-notes";
import { getReleaseInfo } from "../lib/release-info.server";
import { authenticate } from "../shopify.server";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    const { session } = await authenticate.admin(request);
    setLogShopDomain(session.shop);
    log.event("admin_page_view", { path: "/app/release-notes" });

    return {
      release: getReleaseInfo(),
      releaseNotes: RELEASE_NOTES.slice(0, RELEASE_NOTES_DISPLAY_LIMIT),
    };
  });
};

export default function ReleaseNotesPage() {
  const { release, releaseNotes } = useLoaderData<typeof loader>();

  return (
    <Page title="What's new" subtitle={`PrintDock v${release.appVersion}`}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="p">
              We ship regular improvements to uploads, checkout, and how orders look in Shopify
              Admin.
            </Text>
            <Text as="p" tone="subdued">
              You&apos;re on the latest version.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent updates
            </Text>
            <Divider />
            <BlockStack gap="300">
              {releaseNotes.map((entry) => (
                <BlockStack key={entry.version} gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" fontWeight="semibold">
                      v{entry.version}
                    </Text>
                    <Text as="span" tone="subdued">
                      {entry.date}
                    </Text>
                  </InlineStack>
                  <Text as="p">{entry.summary}</Text>
                </BlockStack>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
