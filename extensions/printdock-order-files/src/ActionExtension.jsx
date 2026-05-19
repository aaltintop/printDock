import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

const DOWNLOAD_URL_KEYS = new Set([
  "Print Ready File",
  "_Print Ready File",
  "View uploads",
  "_View uploads",
  "__View uploads",
  "_View uploads",
]);
const PRINTDOCK_SHORT_URL_RE = /https:\/\/[^\s]+\/apps\/printdock\/f\/[A-Za-z0-9]+/i;

const ORDER_FILES_QUERY = `#graphql
  query PrintDockOrderFiles($id: ID!) {
    order(id: $id) {
      name
      lineItems(first: 100) {
        nodes {
          id
          title
          quantity
          customAttributes {
            key
            value
          }
          lineItemGroup {
            id
            title
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  }
`;

/**
 * PrintDock order file downloads — admin action.
 *
 * More actions → PrintDock files on the order details page.
 * Reads `Print Ready File` from each line's customAttributes and from
 * lineItemGroup.customAttributes (native bundles / "Part of:" lines).
 */
function Extension() {
  const shopify = typeof globalThis !== "undefined" ? globalThis.shopify : undefined;
  const i18n = shopify?.i18n;
  const close = shopify?.close;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!shopify?.query) {
      setError("PrintDock could not access the Shopify admin API.");
      setLoading(false);
      return;
    }

    const orderId = pickOrderId(shopify.data);
    if (!orderId) {
      setError("Could not determine which order to load. Open this action from an order details page.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data, errors } = await shopify.query(ORDER_FILES_QUERY, {
          variables: { id: orderId },
        });

        if (cancelled) return;

        if (errors?.length) {
          setError(errors.map((e) => e.message).filter(Boolean).join("; ") || "GraphQL error");
          setLoading(false);
          return;
        }

        if (!data?.order) {
          setError("Order not found or not accessible.");
          setLoading(false);
          return;
        }

        const nodes = data.order.lineItems?.nodes ?? [];
        const enriched = nodes
          .map((line) => {
            const printUrl = findPrintReadyUrl(line.customAttributes)
              ?? findPrintReadyUrl(line.lineItemGroup?.customAttributes);
            const artwork = findAttributeValue(line.customAttributes, "Artwork")
              ?? findAttributeValue(line.lineItemGroup?.customAttributes, "Artwork");
            const fileName =
              artwork || deriveFileNameFromUrl(printUrl) || line.title;
            return {
              id: line.id,
              title: line.title,
              quantity: line.quantity,
              printUrl,
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
  }, [shopify]);

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

/** Shopify docs: order-details actions use `data.selected[0].id`. */
function pickOrderId(data) {
  if (!data) return null;
  const selected = Array.isArray(data.selected) ? data.selected : [];
  const fromSelected = selected[0]?.id;
  if (typeof fromSelected === "string" && fromSelected.trim()) {
    return fromSelected.trim();
  }
  if (typeof data.id === "string" && data.id.trim()) {
    return data.id.trim();
  }
  return null;
}

function findAttributeValue(attrs, key) {
  if (!Array.isArray(attrs)) return null;
  const hit = attrs.find((attr) => attr?.key === key);
  const value = hit?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findPrintReadyUrl(attrs) {
  if (!Array.isArray(attrs)) return null;
  for (const attr of attrs) {
    const key = String(attr?.key ?? "").trim();
    const raw = String(attr?.value ?? "").trim();
    if (!raw) continue;
    if (DOWNLOAD_URL_KEYS.has(key)) {
      const normalized = normalizePrintReadyUrl(raw);
      if (normalized) return normalized;
    }
    const matched = raw.match(PRINTDOCK_SHORT_URL_RE);
    if (matched) return matched[0];
  }
  return null;
}

function normalizePrintReadyUrl(raw) {
  let s = String(raw).trim();
  if (!/^https:\/\//i.test(s)) {
    const extracted = s.match(PRINTDOCK_SHORT_URL_RE);
    if (extracted) s = extracted[0];
  }
  s = s.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(s)) return null;
  if (!/\/apps\/printdock\/f\/[A-Za-z0-9]+$/i.test(s)) return null;
  return s;
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
