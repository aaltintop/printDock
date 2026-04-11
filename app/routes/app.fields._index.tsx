import crypto from "crypto";
import { data, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { getUploadField, listUploadFields, saveUploadField } from "../services/shop-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status") || "all";

  const fields = await listUploadFields(session.shop);
  const filteredFields = fields
    .filter((field) => {
      const matchesText =
        query.length === 0 ||
        field.adminTitle.toLowerCase().includes(query) ||
        field.productId.toLowerCase().includes(query);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && field.isActive) ||
        (statusFilter === "inactive" && !field.isActive);
      return matchesText && matchesStatus;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return data({
    fields: filteredFields,
    filters: {
      q: query,
      status: statusFilter,
    },
    shopDomain: session.shop,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const fieldId = String(formData.get("fieldId") || "");

  if (!fieldId) {
    return data({ error: "Missing field id" }, { status: 400 });
  }

  const field = await getUploadField(session.shop, fieldId);
  if (!field) {
    return data({ error: "Field not found" }, { status: 404 });
  }

  if (intent === "toggle_active") {
    await saveUploadField(session.shop, {
      ...field,
      isActive: !field.isActive,
      updatedAt: new Date().toISOString(),
    });
    return data({ ok: true });
  }

  if (intent === "duplicate") {
    const nowIso = new Date().toISOString();
    const duplicateId = crypto.randomUUID();
    await saveUploadField(session.shop, {
      ...field,
      id: duplicateId,
      isActive: false,
      adminTitle: `${field.adminTitle} (Copy)`,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return redirect(`/app/fields/${duplicateId}`);
  }

  return data({ error: "Unknown action" }, { status: 400 });
};

export default function FieldsIndexPage() {
  const { fields, filters, shopDomain } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();
  const saved = searchParams.get("saved") === "1";

  return (
    <s-page heading="Upload Fields">
      {saved ? (
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-text><strong>Field saved successfully.</strong></s-text>
        </s-box>
      ) : null}

      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <Form method="get" style={{ display: "flex", gap: 12 }}>
            <input
              type="search"
              name="q"
              defaultValue={filters.q}
              placeholder="Search by title or product ID"
            />
            <select name="status" defaultValue={filters.status}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button type="submit">Filter</button>
          </Form>
          <s-button href="/app/fields/new" tone="critical">
            Create Field
          </s-button>
        </s-stack>
      </s-box>

      <s-box padding="base">
        <s-table>
          <s-table-header-row>
            <s-table-header>Title</s-table-header>
            <s-table-header>Product</s-table-header>
            <s-table-header>Limits</s-table-header>
            <s-table-header>Pricing</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Updated</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {fields.map((field) => {
              const previewUrl = field.productHandle
                ? `https://${shopDomain}/products/${field.productHandle}`
                : null;

              return (
                <s-table-row key={field.id}>
                  <s-table-cell>{field.adminTitle}</s-table-cell>
                  <s-table-cell>{field.productId}</s-table-cell>
                  <s-table-cell>
                    1 file, {field.maxFileMB}MB max
                  </s-table-cell>
                  <s-table-cell>
                    {field.pricing.enabled
                      ? `${field.pricing.unitType} ($${field.pricing.unitPrice})`
                      : "Disabled"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={field.isActive ? "success" : "neutral"}>
                      {field.isActive ? "Active" : "Inactive"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{new Date(field.updatedAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base">
                      <s-button href={`/app/fields/${field.id}`}>Edit</s-button>

                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle_active" />
                        <input type="hidden" name="fieldId" value={field.id} />
                        <button type="submit" disabled={fetcher.state === "submitting"}>
                          {field.isActive ? "Disable" : "Enable"}
                        </button>
                      </fetcher.Form>

                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="duplicate" />
                        <input type="hidden" name="fieldId" value={field.id} />
                        <button type="submit">Duplicate</button>
                      </fetcher.Form>

                      {previewUrl ? (
                        <s-button href={previewUrl} target="_blank">
                          Preview
                        </s-button>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-box>
    </s-page>
  );
}

