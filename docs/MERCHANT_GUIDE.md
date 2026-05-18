# PrintDock — Merchant Guide

This document explains how merchants install, configure, and use PrintDock in their Shopify store.

---

## 1. Installation and Setup

### Install path A: Shopify App Store (production merchants)

1. Open the PrintDock listing in the Shopify App Store.
2. Click **Install app**.
3. Select the target store and approve permissions.
4. After install, open **Shopify Admin > Apps > PrintDock**.

### Install path B: Development store (for testing)

1. In your project, run `npm run dev` (or `shopify app dev`).
2. In the Shopify CLI prompt, connect to the existing app (do not create a new app if this project already has one).
3. Select the target development store.
4. Accept URL updates for dev when prompted (`Yes, automatically update`).
5. In the `npm run dev` terminal output, copy/open the Shopify CLI **installation/preview URL** (the `app-preview` link), then click **Install app** and approve permissions in your development store.
6. After install, open **Shopify Admin > Apps > PrintDock**.

You will land on the **Setup** page (`/app/onboarding`), which walks through four steps:

### Step 1: Add the theme block to your product page

PrintDock uses a **theme app block** (not an app embed). This means you add it directly inside the product page template in the theme editor.

**How to add it:**

1. In Shopify Admin, go to **Online Store > Themes > Customize**.
2. Navigate to a **Product page** template (use the page selector dropdown at the top).
3. In the left sidebar, find the product section and click **Add block**.
4. Under the **Apps** category, select **PrintDock Upload**.
5. Position the block where you want the upload widget to appear (e.g., above the Add to Cart button).
6. In the block settings, toggle "Require upload before add to cart" if the product requires a file upload.
7. Optionally tailor the **look and copy** from the same block settings panel — see Section 11 below for the full list.
8. Click **Save**.

> **Important:** PrintDock does NOT appear under "App embeds" in the theme editor. It is a section block, not an app embed. You must add it inside a product page section.

Once done, return to the Setup page and the app will detect the block (or you can confirm manually).

### Step 2: Cart Validation

This step is auto-verified when PrintDock finds at least one upload field that enforces required upload before Add to Cart (`isRequired = true`).

If you use a custom storefront flow, you can still click **Mark as Verified** manually.

### Step 3: Upload Pricing Setup

If you plan to use upload-based dynamic pricing, click **Set up upload pricing** in onboarding. PrintDock does two things in one action:

1. Stores a shop-specific signing key (used only to secure upload prices; it is never shown to customers).
2. Registers the PrintDock **Cart Transform** function so Shopify can apply your upload fee as part of the **same** cart line as the product.

PrintDock auto-checks the registration status and explains the next step right on the Setup page:

- **Not registered:** Click **Set up upload pricing**. PrintDock calls `cartTransformCreate` for the `auto-pricing` function and links it to your store.
- **Missing permissions:** PrintDock needs the `read_cart_transforms` and `write_cart_transforms` scopes. Click **Reauthorize PrintDock** to grant them.
- **Function not deployed:** The PrintDock function package has not been deployed to your shop yet. Run `shopify app deploy` and reinstall the app.
- **Verification unavailable:** Shopify did not respond with cart transform data for this shop. Finish onboarding once Cart Transform shows as registered, or contact support if the status never updates.
- **Cart Transform conflict:** Shopify allows only one Cart Transform owner at a time. If another app already manages Cart Transform, disable it before enabling PrintDock upload pricing.

You no longer need to mark this step as verified manually — registration status and the signing key are the source of truth.

### Step 4: Create your first field

Click **Create Field** to set up your first field configuration. This links to the Fields editor page. See Section 3 below.

---

## 2. Dashboard

The main dashboard (`/app`) shows:

- **KPI cards:** Total uploads, total orders, blocked uploads, conversion rate, and storage used.
- **Onboarding checklist:** Quick view of your setup progress.
- **Quick links:** Jump to Fields, Orders, Plans, and Settings.
- **Recent activity:** Latest upload sessions and order jobs.

---

## 3. Fields

Fields are the core configuration of PrintDock. Each field defines **which product** gets an upload widget, what file rules apply, and how pricing works.

### Creating a Field

Go to **Fields** (`/app/fields`) and click **Create Field**.

**Field Basics:**
- **Admin title:** Internal name for this field (e.g., "DTF Gang Sheet Upload").
- **Product:** Select which product this field applies to.
- **Target variants:** Optionally restrict the upload widget to specific variants.
- **Active:** Toggle the field on/off without deleting it.
- **Required:** Whether the customer must upload a file before adding to cart.

**Storefront Content:**
- **Storefront title:** The heading customers see above the upload widget.
- **Storefront description:** Helper text shown to customers.
- **File renaming pattern:** How files are renamed after an order is placed. Available tokens: `{orderId}`, `{lineItemId}`, `{originalName}`, `{date}`, etc.

**File Rules:**
- **Allowed extensions:** Comma-separated list (e.g., `png,jpg,jpeg,pdf`).
- **Max file size (MB):** Upper limit per file.
- Currently, each field supports **single-file upload** (one file per product line item).

**Pricing:**
- **Enable dynamic pricing:** When enabled, the app calculates a price based on the uploaded file's dimensions.
- **Unit type:** Flat, per file, per inch height, or per square inch.
- **Unit price / Minimum price:** Base pricing parameters.
- **Target DPI / Print width:** Used for dimension-based pricing calculations (e.g., DTF gang sheets at 22" width).
- **Rounding:** Round calculated dimensions up to the nearest inch.

**Dimension Rules:**
- JSON-based rules that can **warn** or **block** uploads based on file dimensions, DPI, page count, or file size.

**Plan Requirement:**
- Set which billing plan tier is needed for this field to work (Free, Basic Plus, Pro Plus).

### Managing Fields

From the Fields list page, you can:
- **Edit** any field.
- **Enable/Disable** a field without deleting it.
- **Duplicate** a field to create a similar configuration for another product.
- **Preview** the product page where the upload widget appears.

After saving a field, you are redirected to the Fields list with a success confirmation.

---

## 4. How the Storefront Upload Works

When a customer visits a product page that has PrintDock configured:

1. The upload widget loads and fetches the field configuration from your app.
2. The customer selects a file. The widget validates the file type and size.
3. The file is uploaded directly to cloud storage (Firebase/Google Cloud Storage) via a secure presigned URL.
4. The app validates the file server-side (dimensions, DPI, rules) and calculates pricing if enabled.
5. Validation results and calculated price are displayed to the customer.
6. If the file passes all rules, the **Add to Cart** button is unblocked.
7. When added to cart, line item properties are injected (all visible on the order in Admin):
   - `_uc_session` — links the cart line to the upload session and powers webhooks.
   - `_pd_price_token` — when dynamic pricing applies, a short-lived signed token so Cart Transform can set the final per-unit price at checkout.
   - `_Artwork` — uploaded file name(s), `_View uploads` — link into the app, and optionally `_Print Ready File` for download; see `docs/MERCHANT_FIELDS.md`.

If a customer uploads files but never adds the item to cart, PrintDock removes those non-converted uploads after about 2 hours.

### Dynamic Pricing at Checkout

If dynamic pricing is enabled and setup is complete, the storefront adds a single product line. At checkout, PrintDock Cart Transform reads the signed token and the cart clock attribute (`__pd_now`) and sets the line’s **fixed price per unit** to match your calculated base product price plus upload fee. Quantity changes stay on one line; there are no separate fee SKU lines.

### Discounts and Taxes

Upload fees ride on the same line item as the configured product variant, so your normal product discount and tax rules apply to the combined amount. If you need upload fees to behave differently from the base product, use Shopify’s discount and tax tools with that in mind.

### Selling Plan Limitation

Shopify can reject cart transform price adjustments when selling plans are attached. PrintDock skips transform operations for lines with selling plans to prevent broken checkout behavior.

---

## 5. Orders

When a customer completes checkout, the `orders/create` webhook fires and PrintDock:

1. Finds line items with upload session data.
2. Creates an **Order Job** for each uploaded file.
3. Renames and copies the file in storage using the field's renaming pattern.
4. Records the calculated price, quantity, and customer details.
5. Optionally auto-assigns the job to a team member (based on Settings).

For the full order-line metadata contract (merchant-facing and internal fields), see `docs/MERCHANT_FIELDS.md`.

### Order Jobs Page

The **Orders** page (`/app/orders`) shows all order jobs with:

- **Search and filter** by status, text query.
- **Status management:** Update job status directly from row actions or the order detail page.
- **Assignee and notes:** Assign jobs to team members and add internal notes.
- **File download:** Download the uploaded file directly from the table or detail page.
- **Audit trail:** Each status change and action is logged.
- **Pagination:** Navigate through large order lists.

Current order-job statuses:

- **Uploaded:** File is received and waiting for quality review.
- **Pending review:** File has a warning/blocking concern or is marked for manual review.
- **Approved:** File is approved and ready for production.

How statuses are set:

- New jobs start as **Uploaded** or **Pending review** automatically, based on validation warnings.
- Merchants can change status from row action buttons (`Mark approved` / `Mark review`) or from the order detail page.

---

## 6. Uploads

The **Uploads** page (`/app/uploads`) shows all customer upload sessions:

- File name, status, size, and upload date.
- Download button to retrieve the original uploaded file.
- Sessions are linked to order jobs after checkout.

---

## 7. Plans and Billing

The **Plans** page (`/app/plans`) shows available tiers:

| Feature | Free | Basic Plus | Pro Plus |
|---------|------|-----------|----------|
| Max file size | Limited | Higher | Highest |
| Monthly uploads | Limited | More | Unlimited |
| Auto pricing | No | Yes | Yes |
| Advanced rules | No | No | Yes |

Select a plan to start a Shopify billing subscription. Plan limits are enforced both in the admin UI and on the storefront upload API.

---

## 8. Settings

The **Settings** page (`/app/settings`) configures global app behavior:

- **Language:** Default language for storefront content.
- **Style preset:** Visual style of the upload widget.
- **Upload retention days:** How long uploaded files are kept in storage.
  - Non-converted uploads are cleaned separately with a short (~2 hour) orphan sweep.
- **Default order status:** Initial status for new order jobs.
- **Auto-assignment:** Automatically assign order jobs to a team member based on email domain matching.
- **Theme block health check:** Verify your theme block is properly installed.

---

## 9. Common Workflows

### Setting up a DTF gang sheet product with dynamic pricing

1. Create a product in Shopify (e.g., "Custom DTF Gang Sheet").
2. In PrintDock, go to **Fields > Create Field**.
3. Select the product and set:
   - Allowed extensions: `png`
   - Max file MB: `50`
   - Enable dynamic pricing with unit type "per inch height", unit price `$3.50`, print width `22`, DPI `300`.
4. Save the field.
5. In the theme editor, add the **PrintDock Upload** block to the product page template.
6. Customers can now upload their artwork, see the calculated price, and check out with automatic pricing.

### Viewing and fulfilling an order

1. Customer uploads a file and completes checkout.
2. Go to **Orders** in PrintDock.
3. Find the order job, download the file.
4. Review and update status (e.g., `Uploaded` -> `Pending review` -> `Approved`).

---

## 10. Troubleshooting

| Issue | Solution |
|-------|----------|
| Upload widget not showing on product page | Ensure the PrintDock Upload block is added to the product page template in the theme editor (not App embeds). |
| "Upload failed" error | Check browser console for CORS errors. Verify Firebase Storage CORS is configured. |
| Upload API returns 404 on `/apps/printdock/...` | Run `shopify app deploy`, then reinstall the app on the store. Start `shopify app dev` and confirm an `app_proxy` URL is shown in CLI output. Re-test `/apps/printdock/api/proxy/upload/config`. |
| Orders not appearing in Order Jobs | Ensure the `orders/create` webhook is active and "Protected customer data" access is granted in the Shopify Partner Dashboard. |
| Dynamic pricing not applying at checkout | Open **Setup** in PrintDock and confirm **Cart Transform** is registered and upload pricing completed. If not, click **Set up upload pricing**. If Shopify reports missing scope or function not deployed, click **Reauthorize PrintDock** or run `shopify app deploy` and reinstall the app. |
| Theme block not detected in onboarding | The `read_themes` scope must be granted. Reinstall the app if prompted. |

---

## 11. Customizing the storefront widget appearance

The **PrintDock Upload** theme block exposes a full set of appearance controls directly in the theme editor, so you can match the widget to your store without writing any code. Open the block settings from **Online Store > Themes > Customize > Product page** and expand each section.

### Colors

Every color drawn by the widget is adjustable:

- **Primary** / **On primary** — background and text for the "Choose file" button and the dropzone hover accent.
- **Success** / **Success (strong)** — progress-bar gradient (start → end) and success status text.
- **Danger** — error messages and the remove ("X") icon.
- **Warning** — warning validation messages.
- **Card background** — the background of each uploaded-file card.
- **Dropzone & price background** — the "Drop your artwork here" area and the calculated-price box.
- **Card border** / **Dropzone border** — subtle and dashed borders respectively.
- **Text** / **Text (subdued)** — main copy and secondary copy (file props, helper text).

### Layout

- **Corner radius** — round corners from 0 to 24 px across the dropzone, cards, buttons, and price box.
- **Text size** — scales widget typography from 85 % to 120 %.
- **Density** — choose *Compact*, *Regular*, or *Roomy* to tighten or loosen spacing.

### Text

Every built-in string is overridable:

- **Dropzone headline** — the big call-to-action above the "Choose file" button.
- **Choose button label** — the button text itself.
- **Validating label** — shown during server-side file checks (e.g. "Checking file...").
- **Calculated price label** — label above the calculated upload price.

> Field-specific copy (the title and description that appears at the top of the widget) still lives on each field in **PrintDock > Fields** so it can vary per product.

### Advanced: Custom CSS

The block also includes a **Custom CSS** textarea under the *Advanced* header. Use it for targeted tweaks the built-in controls don't cover — for example:

```css
/* Make the card shadow theme-matched */
.printdock-file-card {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* Larger thumbnails on wide screens */
@media (min-width: 960px) {
  .printdock-file-thumb {
    width: 64px;
    height: 64px;
  }
}

/* Override a design token */
.printdock-upload {
  --pd-radius: 16px;
}
```

All widget styles live under the `.printdock-upload` root and the `#printdock-upload-root` wrapper, so the CSS you add here stays scoped to the block and won't affect the rest of your theme. Design tokens (the `--pd-…` variables used by every rule) can be overridden the same way from your theme's main CSS if you prefer central control.

---

## Quick Reference: Admin Pages

| Page | URL | Purpose |
|------|-----|---------|
| Dashboard | `/app` | KPIs, recent activity, quick links |
| Setup | `/app/onboarding` | Installation wizard |
| Fields | `/app/fields` | Manage field configurations |
| Uploads | `/app/uploads` | View all customer upload sessions |
| Orders | `/app/orders` | Manage order jobs and fulfillment |
| Plans | `/app/plans` | Billing plan selection |
| Settings | `/app/settings` | Global app configuration |
