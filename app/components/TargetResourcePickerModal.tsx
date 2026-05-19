import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import {
  BlockStack,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineStack,
  Modal,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import type {
  TargetResourceKind,
  TargetResourceSearchItem,
  TargetResourceSearchResult,
} from "../services/target-resource-search.server";
import type { FieldTargetCollection, FieldTargetProduct } from "../types/printdock";

type PickerSelection = FieldTargetProduct | FieldTargetCollection;

type SearchFetcherData = TargetResourceSearchResult | { error: string };

type TargetResourcePickerModalProps = {
  kind: TargetResourceKind;
  open: boolean;
  initialSelection: PickerSelection[];
  onClose: () => void;
  onConfirm: (selection: PickerSelection[]) => void;
};

const SEARCH_PATH = "/app/fields/resources/search";

function kindLabels(kind: TargetResourceKind) {
  if (kind === "product") {
    return {
      title: "Select products",
      searchPlaceholder: "Search products",
      countLabel: (count: number) =>
        count === 1 ? "1 product selected" : `${count} products selected`,
      empty: "No products found",
    };
  }
  return {
    title: "Select collections",
    searchPlaceholder: "Search collections",
    countLabel: (count: number) =>
      count === 1 ? "1 collection selected" : `${count} collections selected`,
    empty: "No collections found",
  };
}

function toPickerSelection(
  kind: TargetResourceKind,
  item: TargetResourceSearchItem,
): PickerSelection {
  if (kind === "product") {
    return {
      id: item.id,
      title: item.title,
      handle: item.handle ?? "",
    };
  }
  return {
    id: item.id,
    title: item.title,
  };
}

export function TargetResourcePickerModal({
  kind,
  open,
  initialSelection,
  onClose,
  onConfirm,
}: TargetResourcePickerModalProps) {
  const labels = kindLabels(kind);
  const location = useLocation();
  const fetcher = useFetcher<SearchFetcherData>({ key: `target-resources-${kind}` });
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loadedItems, setLoadedItems] = useState<TargetResourceSearchItem[]>([]);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedById, setSelectedById] = useState<Map<string, PickerSelection>>(new Map());
  const appendNextPageRef = useRef(false);

  const initialSelectionKey = useMemo(
    () => initialSelection.map((item) => item.id).sort().join(","),
    [initialSelection],
  );

  const searchUrl = useCallback(
    (query: string, after: string | null) => {
      const params = new URLSearchParams(location.search);
      params.set("kind", kind);
      if (query) params.set("query", query);
      else params.delete("query");
      if (after) params.set("after", after);
      else params.delete("after");
      return `${SEARCH_PATH}?${params.toString()}`;
    },
    [kind, location.search],
  );

  useEffect(() => {
    if (!open) return;
    const map = new Map<string, PickerSelection>();
    for (const item of initialSelection) {
      map.set(item.id, item);
    }
    setSelectedById(map);
    setSearchQuery("");
    setDebouncedQuery("");
    setLoadedItems([]);
    setEndCursor(null);
    setHasNextPage(false);
    setLoadError(null);
  }, [open, initialSelectionKey, initialSelection]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [open, searchQuery]);

  useEffect(() => {
    if (!open) return;
    appendNextPageRef.current = false;
    setLoadError(null);
    if (!appendNextPageRef.current) {
      setLoadedItems([]);
      setEndCursor(null);
      setHasNextPage(false);
    }
    fetcher.load(searchUrl(debouncedQuery, null));
    // Only re-fetch when the modal opens or the debounced query / kind changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher.load is stable enough; including fetcher retriggers endlessly
  }, [open, debouncedQuery, kind, searchUrl]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data) return;

    if ("error" in fetcher.data) {
      setLoadError(fetcher.data.error);
      if (!appendNextPageRef.current) {
        setLoadedItems([]);
      }
      return;
    }

    const result = fetcher.data;
    setLoadError(null);
    if (appendNextPageRef.current) {
      setLoadedItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const additions = result.items.filter((item) => !seen.has(item.id));
        return [...prev, ...additions];
      });
    } else {
      setLoadedItems(result.items);
    }
    setEndCursor(result.endCursor);
    setHasNextPage(result.hasNextPage);
  }, [fetcher.data, fetcher.state]);

  const loadMore = useCallback(() => {
    if (!hasNextPage || !endCursor || fetcher.state !== "idle") return;
    appendNextPageRef.current = true;
    fetcher.load(searchUrl(debouncedQuery, endCursor));
  }, [debouncedQuery, endCursor, fetcher, hasNextPage, searchUrl]);

  const isLoading = open && fetcher.state === "loading" && loadedItems.length === 0 && !loadError;
  const isLoadingMore = fetcher.state === "loading" && loadedItems.length > 0;

  const visibleIds = useMemo(() => loadedItems.map((item) => item.id), [loadedItems]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedById.has(id));

  const toggleItem = useCallback((item: TargetResourceSearchItem, checked: boolean) => {
    setSelectedById((prev) => {
      const next = new Map(prev);
      if (checked) {
        next.set(item.id, toPickerSelection(kind, item));
      } else {
        next.delete(item.id);
      }
      return next;
    });
  }, [kind]);

  const toggleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedById((prev) => {
        const next = new Map(prev);
        for (const item of loadedItems) {
          if (checked) {
            next.set(item.id, toPickerSelection(kind, item));
          } else {
            next.delete(item.id);
          }
        }
        return next;
      });
    },
    [kind, loadedItems],
  );

  const selectedCount = selectedById.size;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={labels.title}
      size="large"
    >
      <Modal.Section flush>
        <Box padding="400" paddingBlockEnd="200">
          <TextField
            label={labels.searchPlaceholder}
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={labels.searchPlaceholder}
            autoComplete="off"
            clearButton
            onClearButtonClick={() => setSearchQuery("")}
          />
        </Box>
        {loadedItems.length > 0 ? (
          <Box paddingInline="400" paddingBlockEnd="200">
            <Checkbox
              label="Select all"
              checked={allVisibleSelected}
              onChange={toggleSelectAllVisible}
            />
          </Box>
        ) : null}
        <Divider />
        <div style={{ minHeight: 280, maxHeight: 360, overflowY: "auto" }}>
          {isLoading ? (
            <Box padding="800">
              <InlineStack align="center">
                <Spinner accessibilityLabel="Loading resources" size="large" />
              </InlineStack>
            </Box>
          ) : loadError ? (
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="p" tone="critical" alignment="center">
                  {loadError}
                </Text>
                <InlineStack align="center">
                  <Button
                    onClick={() => {
                      appendNextPageRef.current = false;
                      fetcher.load(searchUrl(debouncedQuery, null));
                    }}
                  >
                    Try again
                  </Button>
                </InlineStack>
              </BlockStack>
            </Box>
          ) : loadedItems.length === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued" alignment="center">
                {labels.empty}
              </Text>
            </Box>
          ) : (
            <BlockStack gap="0">
              {loadedItems.map((item) => {
                const checked = selectedById.has(item.id);
                return (
                  <Box
                    key={item.id}
                    padding="300"
                    paddingInline="400"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Checkbox
                        label={item.title || `Item ${item.id}`}
                        labelHidden
                        checked={checked}
                        onChange={(nextChecked) => toggleItem(item, nextChecked)}
                      />
                      <Thumbnail
                        source={item.imageUrl || ImageIcon}
                        alt=""
                        size="small"
                      />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {item.title || `Item ${item.id}`}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {item.subtitle}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                );
              })}
            </BlockStack>
          )}
        </div>
        {hasNextPage ? (
          <Box padding="300" paddingInline="400">
            <Button fullWidth loading={isLoadingMore} onClick={loadMore}>
              Load more
            </Button>
          </Box>
        ) : null}
        <Divider />
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodyMd">
              {labels.countLabel(selectedCount)}
            </Text>
            <InlineStack gap="200">
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={selectedCount === 0}
                onClick={() => onConfirm(Array.from(selectedById.values()))}
              >
                Select
              </Button>
            </InlineStack>
          </InlineStack>
        </Box>
      </Modal.Section>
    </Modal>
  );
}
