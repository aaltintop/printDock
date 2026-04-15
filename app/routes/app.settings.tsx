import { data, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { getAppSettings, saveAppSettings } from "../services/shop-data.server";
import { authenticate } from "../shopify.server";
import type { AppSettings } from "../types/printdock";

type ThemeNode = {
  id: string;
  role: string;
  files?: {
    edges?: Array<{
      node?: {
        body?: {
          content?: string;
        };
      };
    }>;
  };
};

function isReadThemesScopeError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || "");
  return (
    message.includes("Access denied for themes field") ||
    message.includes("`read_themes`") ||
    message.includes("read_themes")
  );
}

async function getThemeBlockStatus(admin: any, shopDomain: string) {
  try {
    const response = await admin.graphql(`
    #graphql
    query PrintDockSettingsTheme {
      themes(first: 20) {
        edges {
          node {
            id
            role
            files(filenames: ["config/settings_data.json"]) {
              edges {
                node {
                  ... on OnlineStoreThemeFile {
                    body {
                      ... on OnlineStoreThemeFileBodyText {
                        content
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

    const json = await response.json();
    const themes: ThemeNode[] = json?.data?.themes?.edges?.map((edge: any) => edge.node) ?? [];
    const mainTheme = themes.find((theme) => theme.role === "MAIN") ?? themes[0];
    if (!mainTheme) {
      return {
        enabled: false,
        themeEditorUrl: `https://${shopDomain}/admin/themes`,
        verificationUnavailable: false,
        verificationMessage: null,
      };
    }

    const settingsContent = mainTheme.files?.edges?.[0]?.node?.body?.content ?? "";
    const enabled =
      settingsContent.includes("shopify://apps/printdock/blocks/upload/") ||
      settingsContent.includes("printdock-upload");
    const themeId = mainTheme.id.replace("gid://shopify/OnlineStoreTheme/", "");
    return {
      enabled,
      themeEditorUrl: themeId
        ? `https://${shopDomain}/admin/themes/${themeId}/editor?context=apps`
        : `https://${shopDomain}/admin/themes`,
      verificationUnavailable: false,
      verificationMessage: null,
    };
  } catch (error) {
    if (isReadThemesScopeError(error)) {
      return {
        enabled: false,
        themeEditorUrl: `https://${shopDomain}/admin/themes`,
        verificationUnavailable: true,
        verificationMessage:
          "Theme verification is unavailable because the app is missing `read_themes` scope.",
      };
    }

    console.error("Theme block health check failed:", error);
    return {
      enabled: false,
      themeEditorUrl: `https://${shopDomain}/admin/themes`,
      verificationUnavailable: true,
      verificationMessage: "Theme verification failed. Please verify app block status manually.",
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getAppSettings(session.shop);
  const blockStatus = await getThemeBlockStatus(admin, session.shop);

  return data({
    settings,
    blockStatus,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const stylePreset = String(formData.get("stylePreset")) === "high_contrast"
    ? "high_contrast"
    : "minimal";

  const nextSettings: Partial<AppSettings> = {
    language: String(formData.get("language") || "en"),
    stylePreset,
    requireThemeBlock: formData.get("requireThemeBlock") === "on",
    uploadRetentionDays: Math.max(1, Number(formData.get("uploadRetentionDays") || 30)),
    defaultOrderStatus: String(formData.get("defaultOrderStatus") || "uploaded"),
    csvDelimiter: String(formData.get("csvDelimiter")) === ";" ? (";" as const) : ("," as const),
    autoAssignEnabled: formData.get("autoAssignEnabled") === "on",
    autoAssignEmailDomain: String(formData.get("autoAssignEmailDomain") || ""),
  };

  await saveAppSettings(session.shop, nextSettings);
  return data({ ok: true });
};

export default function SettingsPage() {
  const { settings, blockStatus } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [form, setForm] = useState({
    language: settings.language,
    stylePreset: settings.stylePreset,
    requireThemeBlock: settings.requireThemeBlock,
    uploadRetentionDays: String(settings.uploadRetentionDays),
    defaultOrderStatus: settings.defaultOrderStatus,
    csvDelimiter: settings.csvDelimiter,
    autoAssignEnabled: settings.autoAssignEnabled,
    autoAssignEmailDomain: settings.autoAssignEmailDomain,
  });

  return (
    <Page title="Global Settings">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Theme Block Health
              </Text>
              <Badge tone={blockStatus.enabled ? "success" : "critical"}>
                {blockStatus.enabled ? "Enabled" : "Not enabled"}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Keep the PrintDock app block enabled in your product templates.
            </Text>
            {blockStatus.verificationUnavailable && blockStatus.verificationMessage ? (
              <Text as="p" tone="critical">
                {blockStatus.verificationMessage}
              </Text>
            ) : null}
            <Button url={blockStatus.themeEditorUrl || "/app/onboarding"} target="_blank">
              Open Theme Editor
            </Button>
          </BlockStack>
        </Card>

        <Card>
          <form method="post">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                App Defaults
              </Text>

              <Select
                name="language"
                label="Language"
                value={form.language}
                options={[
                  { label: "English", value: "en" },
                  { label: "German", value: "de" },
                  { label: "Turkish", value: "tr" },
                ]}
                onChange={(value) => setForm((prev) => ({ ...prev, language: value }))}
              />

              <Select
                name="stylePreset"
                label="Style preset"
                value={form.stylePreset}
                options={[
                  { label: "Minimal", value: "minimal" },
                  { label: "High contrast", value: "high_contrast" },
                ]}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    stylePreset: value as "minimal" | "high_contrast",
                  }))
                }
              />

              <Checkbox
                name="requireThemeBlock"
                label="Require theme block before storefront uploads"
                checked={form.requireThemeBlock}
                onChange={(checked) => setForm((prev) => ({ ...prev, requireThemeBlock: checked }))}
              />

              <TextField
                name="uploadRetentionDays"
                label="Upload retention days"
                type="number"
                autoComplete="off"
                value={form.uploadRetentionDays}
                onChange={(value) => setForm((prev) => ({ ...prev, uploadRetentionDays: value }))}
              />

              <TextField
                name="defaultOrderStatus"
                label="Default order status"
                autoComplete="off"
                value={form.defaultOrderStatus}
                onChange={(value) => setForm((prev) => ({ ...prev, defaultOrderStatus: value }))}
              />

              <Select
                name="csvDelimiter"
                label="CSV delimiter"
                value={form.csvDelimiter}
                options={[
                  { label: "Comma", value: "," },
                  { label: "Semicolon", value: ";" },
                ]}
                onChange={(value) => setForm((prev) => ({ ...prev, csvDelimiter: value as "," | ";" }))}
              />

              <Checkbox
                name="autoAssignEnabled"
                label="Enable auto assignment by email domain"
                checked={form.autoAssignEnabled}
                onChange={(checked) => setForm((prev) => ({ ...prev, autoAssignEnabled: checked }))}
              />

              <TextField
                name="autoAssignEmailDomain"
                label="Auto assign email domain"
                autoComplete="off"
                placeholder="@company.com"
                value={form.autoAssignEmailDomain}
                onChange={(value) => setForm((prev) => ({ ...prev, autoAssignEmailDomain: value }))}
              />

              <Button submit variant="primary" loading={isSubmitting}>
                Save Settings
              </Button>
            </BlockStack>
          </form>
        </Card>
      </BlockStack>
    </Page>
  );
}

