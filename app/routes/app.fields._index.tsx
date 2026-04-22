import {
  data,
  Form,
  redirect,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Modal,
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
import { isWithinFieldLimit, merchantUpgradeHint } from "../config/plans";
import { authenticate } from "../shopify.server";
import {
  getEffectiveBillingPlan,
  getUploadField,
  listUploadFields,
  saveUploadField,
  softDeleteUploadField,
} from "../services/shop-data.server";
import type { UploadFieldConfig } from "../types/printdock";
import { FieldTargetOverlapBannerContent } from "../components/FieldTargetOverlapBannerContent";
import { analyzeActiveFieldTargetOverlaps } from "../utils/field-target-overlaps";
import { log, runWithRequestContext, setLogShopDomain } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
      log.event("admin_page_view", { path: "/app/fields" });
      const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status") || "all";

  const allFields = await listUploadFields(session.shop);
  const billingPlan = await getEffectiveBillingPlan(session.shop);
  const canCreateMoreFields = isWithinFieldLimit(billingPlan.planCode, allFields.length);

  const targetOverlapAnalysis = analyzeActiveFieldTargetOverlaps(allFields);

  const filteredFields = allFields
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
        canCreateMoreFields,
        targetOverlapAnalysis,
      });
    } catch (err) {
      log.error("admin_fields_index_loader_failed", err, { path: "/app/fields" });
      throw err;
    }
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return runWithRequestContext(request, async () => {
    try {
      const { session } = await authenticate.admin(request);
      setLogShopDomain(session.shop);
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
        log.event("field_updated", { fieldId, action: "toggle_active" });
        await saveUploadField(session.shop, {
          ...field,
          isActive: !field.isActive,
          updatedAt: new Date().toISOString(),
        });
        return data({ ok: true });
      }

      if (intent === "duplicate") {
        const billingPlan = await getEffectiveBillingPlan(session.shop);
        const allFields = await listUploadFields(session.shop);
        if (!isWithinFieldLimit(billingPlan.planCode, allFields.length)) {
          return data({ error: merchantUpgradeHint("moreUploadFields") }, { status: 402 });
        }

        const nowIso = new Date().toISOString();
        const duplicateId = crypto.randomUUID();
        log.event("field_created", { sourceFieldId: fieldId, newFieldId: duplicateId, via: "duplicate" });
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

      if (intent === "delete") {
        log.event("field_soft_deleted", { fieldId });
        const removed = await softDeleteUploadField(session.shop, fieldId);
        if (!removed) {
          return data({ error: "Could not delete this field." }, { status: 404 });
        }
        return data({ deleted: true as const });
      }

      log.warn("fields_index_unknown_intent", "Unknown fields index intent", { intent });
      return data({ error: "Unknown action" }, { status: 400 });
    } catch (err) {
      log.error("admin_fields_index_action_failed", err, { path: "/app/fields" });
      throw err;
    }
  });
};

export default function FieldsIndexPage() {
  const { fields, filters, shopDomain, canCreateMoreFields, targetOverlapAnalysis } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const appBridge = useAppBridge();
  const [searchParams] = useSearchParams();
  const [queryText, setQueryText] = useState(filters.q);
  const [statusFilter, setStatusFilter] = useState(filters.status);
  const [activePopoverId, setActivePopoverId] = useState<string | null>(null);
  const [fieldPendingDelete, setFieldPendingDelete] = useState<UploadFieldConfig | null>(null);
  const toast = searchParams.get("toast");

  useEffect(() => {
    if (toast === "field_saved") {
      appBridge.toast.show("Field saved");
    }
  }, [appBridge, toast]);

  useEffect(() => {
    if (fetcher.data && "deleted" in fetcher.data && fetcher.data.deleted) {
      appBridge.toast.show("Field deleted");
      setFieldPendingDelete(null);
      revalidator.revalidate();
    }
  }, [appBridge, fetcher.data, revalidator]);

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      appBridge.toast.show("Field updated");
    }
  }, [appBridge, fetcher.data]);

  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      appBridge.toast.show(fetcher.data.error, { isError: true });
    }
  }, [appBridge, fetcher.data]);

  const resourceName = useMemo(
    () => ({ singular: "field", plural: "fields" }),
    [],
  );

  if (navigation.state === "loading") {
    return (
      <Page title="Fields">
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
      title="Fields"
      primaryAction={
        canCreateMoreFields
          ? { content: "Create Field", url: "/app/fields/new" }
          : { content: "Create Field", disabled: true }
      }
      secondaryActions={
        canCreateMoreFields ? undefined : [{ content: "View plans", url: "/app/plans" }]
      }
    >
      <BlockStack gap="400">
        {!canCreateMoreFields ? (
          <Banner
            tone="warning"
            title="Field limit reached"
            action={{ content: "View plans", url: "/app/plans" }}
          >
            {merchantUpgradeHint("moreUploadFields")}
          </Banner>
        ) : null}
        {targetOverlapAnalysis.hasOverlap ? (
          <Banner tone="info" title="Some products or collections are covered by more than one active field">
            <FieldTargetOverlapBannerContent analysis={targetOverlapAnalysis} />
          </Banner>
        ) : null}
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
              heading="No fields yet"
              action={
                canCreateMoreFields ? { content: "Create field", url: "/app/fields/new" } : undefined
              }
              secondaryAction={
                canCreateMoreFields ? undefined : { content: "View plans", url: "/app/plans" }
              }
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Create your first field to start accepting artwork from customers.
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
                          fixed
                          preferredPosition="mostSpace"
                          preferredAlignment="right"
                          autofocusTarget="first-node"
                          ariaHaspopup="menu"
                          onClose={() => setActivePopoverId(null)}
                          activator={
                            <Button
                              size="slim"
                              icon={MenuHorizontalIcon}
                              pressed={activePopoverId === field.id}
                              onClick={() =>
                                setActivePopoverId((prev) => (prev === field.id ? null : field.id))
                              }
                              accessibilityLabel="More actions"
                            />
                          }
                        >
                          <ActionList
                            actionRole="menuitem"
                            sections={[
                              {
                                items: [
                                  {
                                    content: field.isActive ? "Disable" : "Enable",
                                    variant: "menu",
                                    onAction: () => {
                                      setActivePopoverId(null);
                                      fetcher.submit(
                                        { intent: "toggle_active", fieldId: field.id },
                                        { method: "post" },
                                      );
                                    },
                                  },
                                  {
                                    content: "Duplicate",
                                    variant: "menu",
                                    disabled: !canCreateMoreFields,
                                    onAction: () => {
                                      setActivePopoverId(null);
                                      fetcher.submit(
                                        { intent: "duplicate", fieldId: field.id },
                                        { method: "post" },
                                      );
                                    },
                                  },
                                ],
                              },
                              {
                                items: [
                                  {
                                    content: "Remove field",
                                    variant: "menu",
                                    destructive: true,
                                    onAction: () => {
                                      setFieldPendingDelete(field);
                                      setActivePopoverId(null);
                                    },
                                  },
                                ],
                              },
                              {
                                items: previewUrl
                                  ? [
                                      {
                                        content: "View on storefront",
                                        variant: "menu",
                                        onAction: () => {
                                          setActivePopoverId(null);
                                          window.open(
                                            previewUrl,
                                            "_blank",
                                            "noopener,noreferrer",
                                          );
                                        },
                                      },
                                    ]
                                  : [
                                      {
                                        content: "No preview available",
                                        variant: "menu",
                                        disabled: true,
                                        helpText: "Assign a product with a storefront URL",
                                      },
                                    ],
                              },
                            ]}
                          />
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

      <Modal
        open={fieldPendingDelete !== null}
        onClose={() => {
          if (fetcher.state === "submitting") return;
          setFieldPendingDelete(null);
        }}
        title="Remove field?"
        primaryAction={{
          content: "Remove field",
          destructive: true,
          loading:
            fetcher.state === "submitting" &&
            String(fetcher.formData?.get("intent")) === "delete",
          onAction: () => {
            if (!fieldPendingDelete || fetcher.state === "submitting") return;
            fetcher.submit(
              { intent: "delete", fieldId: fieldPendingDelete.id },
              { method: "post" },
            );
          },
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              if (fetcher.state === "submitting") return;
              setFieldPendingDelete(null);
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              Remove{" "}
              <Text as="span" fontWeight="semibold">
                {fieldPendingDelete?.adminTitle ?? "this field"}
              </Text>{" "}
              from your admin and storefront? It will no longer appear in your field list or on
              products. Configuration is kept in our systems for about one year for operational
              purposes, then removed automatically.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

