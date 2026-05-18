import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

/**
 * PrintDock order file downloads — admin action.
 *
 * Lives in the More actions menu on the Shopify Admin order details page.
 * When opened, it queries the order's line items, reads the `Print Ready File`
 * custom attribute on each line, and renders a tappable Download button per
 * uploaded artwork. Files open via the short URL we set on each line.
 */
function Extension() {
  const api = typeof globalThis !== "undefined" ? globalThis.shopify : undefined;
  const i18n = api?.i18n;
  const close = api?.close;
  const data = api?.data;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const orderId = pickOrderId(data);

  useEffect(() => {
    if (!api) return;
    if (!orderId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify({
            query: `#graphql
              query PrintDockOrderFiles($id: ID!) {
                order(id: $id) {
                  lineItems(first: 50) {
                    nodes {
                      id
                      title
                      quantity
                      customAttributes { key value }
                    }
                  }
                }
              }
            `,
            variables: { id: orderId },
          }),
        });

        const json = await response.json();
        if (cancelled) return;

        const nodes = json?.data?.order?.lineItems?.nodes ?? [];
        const enriched = nodes
          .map((line) => {
            const attrs = Array.isArray(line.customAttributes)
              ? line.customAttributes
              : [];
            const printUrl = attrs.find(
              (attr) =>
                attr?.key === "Print Ready File" ||
                attr?.key === "_Print Ready File",
            )?.value;
            const artwork = attrs.find((attr) => attr?.key === "Artwork")?.value;
            const fileName =
              artwork || deriveFileNameFromUrl(printUrl) || line.title;
            return {
              id: line.id,
              title: line.title,
              quantity: line.quantity,
              printUrl: typeof printUrl === "string" ? printUrl : null,
              fileName,
            };
          })
          .filter((line) => Boolean(line.printUrl));

        setFiles(enriched);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message ? String(err.message) : String(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, orderId]);

  return (
    <s-admin-action heading={safeTranslate(i18n, "heading", "PrintDock files")}>
      <s-stack direction="block" gap="base">
        {loading ? (
          <s-spinner
            accessibility-label={safeTranslate(
              i18n,
              "loading",
              "Loading PrintDock uploads",
            )}
            size="base"
          ></s-spinner>
        ) : error ? (
          <s-banner
            tone="critical"
            heading={safeTranslate(
              i18n,
              "errorHeading",
              "Could not load PrintDock uploads",
            )}
          >
            {error}
          </s-banner>
        ) : files.length === 0 ? (
          <s-paragraph color="subdued">
            {safeTranslate(
              i18n,
              "noFiles",
              "No PrintDock uploads on this order.",
            )}
          </s-paragraph>
        ) : (
          files.map((file) => (
            <s-stack
              key={file.id}
              direction="inline"
              gap="base"
              align-items="center"
              justify-content="space-between"
            >
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{file.fileName}</s-text>
                <s-text color="subdued">{file.title}</s-text>
              </s-stack>
              <s-button
                variant="primary"
                icon="download"
                href={file.printUrl}
                target="_blank"
                download={file.fileName || ""}
              >
                {safeTranslate(i18n, "download", "Download")}
              </s-button>
            </s-stack>
          ))
        )}
      </s-stack>
      <s-button slot="primary-action" onClick={() => close?.()}>
        {safeTranslate(i18n, "done", "Done")}
      </s-button>
    </s-admin-action>
  );
}

function safeTranslate(i18n, key, fallback) {
  try {
    if (i18n && typeof i18n.translate === "function") {
      const value = i18n.translate(key);
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch (_err) {
    // i18n key may be missing; fall through to fallback.
  }
  return fallback;
}

function pickOrderId(data) {
  if (!data) return null;
  const selected = Array.isArray(data.selected) ? data.selected : null;
  const first = selected?.[0];
  if (first && typeof first.id === "string") return first.id;
  if (typeof data.id === "string") return data.id;
  return null;
}

function deriveFileNameFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch (_err) {
    return null;
  }
}
