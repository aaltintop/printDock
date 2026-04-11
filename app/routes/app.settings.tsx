import { data } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
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

  return (
    <s-page heading="Global Settings">
      <s-stack direction="block" gap="base">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-heading>Theme Block Health</s-heading>
            <s-badge tone={blockStatus.enabled ? "success" : "critical"}>
              {blockStatus.enabled ? "Enabled" : "Not enabled"}
            </s-badge>
          </s-stack>
          <s-paragraph>
            Keep the PrintDock app block enabled in your product templates.
          </s-paragraph>
          {blockStatus.verificationUnavailable && blockStatus.verificationMessage ? (
            <s-paragraph>{blockStatus.verificationMessage}</s-paragraph>
          ) : null}
          <s-button href={blockStatus.themeEditorUrl || "/app/onboarding"} target="_blank">
            Open Theme Editor
          </s-button>
        </s-box>

        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <form method="post">
            <s-stack direction="block" gap="base">
              <s-heading>App Defaults</s-heading>

              <label>
                Language
                <select name="language" defaultValue={settings.language}>
                  <option value="en">English</option>
                  <option value="de">German</option>
                  <option value="tr">Turkish</option>
                </select>
              </label>

              <label>
                Style preset
                <select name="stylePreset" defaultValue={settings.stylePreset}>
                  <option value="minimal">Minimal</option>
                  <option value="high_contrast">High contrast</option>
                </select>
              </label>

              <label>
                <input
                  type="checkbox"
                  name="requireThemeBlock"
                  defaultChecked={settings.requireThemeBlock}
                />
                Require theme block before storefront uploads
              </label>

              <label>
                Upload retention days
                <input
                  type="number"
                  min="1"
                  name="uploadRetentionDays"
                  defaultValue={settings.uploadRetentionDays}
                />
              </label>

              <label>
                Default order status
                <input
                  type="text"
                  name="defaultOrderStatus"
                  defaultValue={settings.defaultOrderStatus}
                />
              </label>

              <label>
                CSV delimiter
                <select name="csvDelimiter" defaultValue={settings.csvDelimiter}>
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                </select>
              </label>

              <label>
                <input
                  type="checkbox"
                  name="autoAssignEnabled"
                  defaultChecked={settings.autoAssignEnabled}
                />
                Enable auto assignment by email domain
              </label>

              <label>
                Auto assign email domain
                <input
                  type="text"
                  name="autoAssignEmailDomain"
                  placeholder="@company.com"
                  defaultValue={settings.autoAssignEmailDomain}
                />
              </label>

              <s-button type="submit" tone="critical" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save Settings"}
              </s-button>
            </s-stack>
          </form>
        </s-box>
      </s-stack>
    </s-page>
  );
}

