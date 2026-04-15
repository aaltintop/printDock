import { Card, Link, List, Page, Text } from "@shopify/polaris";

export default function AdditionalPage() {
  return (
    <Page title="Additional page">
      <Card>
        <Text as="h2" variant="headingMd">
          Multiple pages
        </Text>
        <div style={{ marginTop: 12 }}>
          <Text as="p" tone="subdued">
            The app template comes with an additional page which demonstrates how to create
            multiple pages within app navigation using{" "}
            <Link url="https://shopify.dev/docs/apps/tools/app-bridge" target="_blank">
              App Bridge
            </Link>
            .
          </Text>
        </div>
        <div style={{ marginTop: 12 }}>
          <Text as="p" tone="subdued">
            To create your own page and have it show up in the app navigation, add a page inside{" "}
            <code>app/routes</code>, and a link to it in the <code>&lt;ui-nav-menu&gt;</code>{" "}
            component found in <code>app/routes/app.tsx</code>.
          </Text>
        </div>
        <div style={{ marginTop: 16 }}>
          <Text as="h3" variant="headingSm">
            Resources
          </Text>
          <List>
            <List.Item>
              <Link
                url="https://shopify.dev/docs/apps/design-guidelines/navigation#app-nav"
                target="_blank"
              >
                App nav best practices
              </Link>
            </List.Item>
          </List>
        </div>
      </Card>
    </Page>
  );
}
