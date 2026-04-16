import { data, Form, redirect, useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Popover,
  Select,
  SkeletonBodyText,
  SkeletonPage,
  Text,
  TextField,
} from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
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
      const targetText = [
        ...field.targetProducts?.map((p) => p.title) ?? [],
        ...field.targetCollections?.map((c) => c.title) ?? [],
        field.productId,
      ].join(" ").toLowerCase();
      const matchesText =
        query.length === 0 ||
        field.adminTitle.toLowerCase().includes(query) ||
        targetText.includes(query);
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
    return redirect(`/app/fields/${duplicateId}?toast=duplicated`);
  }

  return data({ error: "Unknown action" }, { status: 400 });
};

export default function FieldsIndexPage() {
  const { fields, filters, shopDomain } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const appBridge = useAppBridge();
  const [searchParams] = useSearchParams();
  const [queryText, setQueryText] = useState(filters.q);
  const [statusFilter, setStatusFilter] = useState(filters.status);
  const [activePopoverId, setActivePopoverId] = useState<string | null>(null);
  const toast = searchParams.get("toast");

  useEffect(() => {
    if (toast === "field_saved") {
      appBridge.toast.show("Field saved");
    }
  }, [appBridge, toast]);

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      appBridge.toast.show("Field updated");
    }
  }, [appBridge, fetcher.data]);

  const resourceName = useMemo(
    () => ({ singular: "upload field", plural: "upload fields" }),
    [],
  );

  if (navigation.state === "loading") {
    return (
      <Page title="Upload Fields">
        <SkeletonPage primaryAction>
          <Card>
            <SkeletonBodyText lines={10} />
          </Card>
        </SkeletonPage>
      </Page>
    );
  }

  return (
    <Page
      title="Upload Fields"
      primaryAction={{ content: "Create Field", url: "/app/fields/new" }}
    >
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <InlineStack gap="300" align="start" blockAlign="end">
              <div style={{ minWidth: 300 }}>
                <TextField
                  name="q"
                  label="Search"
                  autoComplete="off"
                  placeholder="Search by title or product ID"
                  value={queryText}
                  onChange={setQueryText}
                />
              </div>
              <div style={{ minWidth: 180 }}>
                <Select
                  name="status"
                  label="Status"
                  value={statusFilter}
                  options={[
                    { label: "All", value: "all" },
                    { label: "Active", value: "active" },
                    { label: "Inactive", value: "inactive" },
                  ]}
                  onChange={setStatusFilter}
                />
              </div>
              <Button submit>Filter</Button>
            </InlineStack>
          </Form>
        </Card>

        <Card padding="0">
          {fields.length === 0 ? (
            <EmptyState
              heading="No upload fields yet"
              action={{ content: "Create field", url: "/app/fields/new" }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Create your first upload field to start accepting artwork from customers.
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={resourceName}
              itemCount={fields.length}
              headings={[
                { title: "Title" },
                { title: "Targets" },
                { title: "Limits" },
                { title: "Pricing" },
                { title: "Status" },
                { title: "Updated" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {fields.map((field, index) => {
                const firstHandle = field.targetProducts?.[0]?.handle || field.productHandle;
                const previewUrl = firstHandle
                  ? `https://${shopDomain}/products/${firstHandle}`
                  : null;
                return (
                  <IndexTable.Row id={field.id} key={field.id} position={index}>
                    <IndexTable.Cell>{field.adminTitle}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {(() => {
                        const parts: string[] = [];
                        const pc = field.targetProducts?.length ?? 0;
                        const cc = field.targetCollections?.length ?? 0;
                        if (pc > 0) parts.push(`${pc} product${pc > 1 ? "s" : ""}`);
                        if (cc > 0) parts.push(`${cc} collection${cc > 1 ? "s" : ""}`);
                        if (parts.length === 0 && field.productId) parts.push(`Product ${field.productId}`);
                        return parts.join(", ") || "None";
                      })()}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{`1 file, ${field.maxFileMB}MB max`}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {field.pricing.enabled
                        ? `${field.pricing.unitType} ($${field.pricing.unitPrice})`
                        : "Disabled"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={field.isActive ? "success" : "attention"}>
                        {field.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{new Date(field.updatedAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" wrap={false}>
                        <Button size="slim" url={`/app/fields/${field.id}`}>
                          Edit
                        </Button>
                        <Popover
                          active={activePopoverId === field.id}
                          onClose={() => setActivePopoverId(null)}
                          activator={
                            <Button
                              size="slim"
                              icon={MenuHorizontalIcon}
                              onClick={() =>
                                setActivePopoverId((prev) => (prev === field.id ? null : field.id))
                              }
                              accessibilityLabel="More actions"
                            />
                          }
                        >
                          <BlockStack gap="100">
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="toggle_active" />
                              <input type="hidden" name="fieldId" value={field.id} />
                              <Button
                                submit
                                fullWidth
                                textAlign="left"
                                variant="plain"
                                loading={fetcher.state === "submitting"}
                              >
                                {field.isActive ? "Disable" : "Enable"}
                              </Button>
                            </fetcher.Form>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="duplicate" />
                              <input type="hidden" name="fieldId" value={field.id} />
                              <Button submit fullWidth textAlign="left" variant="plain">
                                Duplicate
                              </Button>
                            </fetcher.Form>
                            {previewUrl ? (
                              <Button url={previewUrl} target="_blank" fullWidth textAlign="left" variant="plain">
                                Preview storefront
                              </Button>
                            ) : (
                              <Text as="p" tone="subdued">
                                No preview available
                              </Text>
                            )}
                          </BlockStack>
                        </Popover>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}

