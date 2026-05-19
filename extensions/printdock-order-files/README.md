# PrintDock order files (Admin UI)

Download uploaded artwork from the Shopify Admin order page and checkout.

## Clickable link on the order line item card

Shopify Admin **auto-linkifies** a line item property when the **value** is a bare `https://` URL (no label or extra text in the value). PrintDock stores:

- **Key:** `Print Ready File`
- **Value:** `https://{storefront-host}/apps/printdock/f/{shortId}`

The short URL must stay clean so Admin renders it as a hyperlink in the native line item details UI — no app block required.

**Note:** On **bundle** orders, **“Part of:”** child lines sometimes show the URL as plain text in Admin even when the value is correct; try a non-bundle test product to confirm link styling, or use **More actions → PrintDock files**.

See `docs/PRINT_READY_FILE_SHORT_LINKS.md` for how URLs are created and resolved.

## Merchant setup — Admin order page (recommended)

1. Open any order in Shopify Admin.
2. Click **Customize** on the order details page.
3. Add the **PrintDock artwork downloads** block and save.

The block shows a **Download print-ready file** link per line item that has a PrintDock upload.

## More actions → PrintDock files

Opens a modal with a **Download** button per line that has a `Print Ready File` URL.

The extension loads line item data via Admin GraphQL and reads:

- `lineItems.nodes[].customAttributes` (standard lines)
- `lineItems.nodes[].lineItemGroup.customAttributes` (native bundle / “Part of:” component lines)

If you still see “No PrintDock uploads on this order” while the line shows `Print Ready File: https://…`, redeploy extensions (`shopify app deploy`) so the latest `ActionExtension.jsx` is active.

## Checkout and thank-you page

The **PrintDock download link** checkout UI extension adds a **Download print-ready file** link under each line item that has a `Print Ready File` property (requires Checkout Extensibility; Shopify Plus on production shops).

Deploy with `shopify app deploy` so both admin and checkout extensions are active.
