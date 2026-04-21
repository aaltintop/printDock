import { BlockStack, Link, List, Text } from "@shopify/polaris";
import type { ActiveTargetOverlapAnalysis } from "../utils/field-target-overlaps";

type Props = {
  analysis: ActiveTargetOverlapAnalysis;
  /** Extra line when the field being edited participates in an overlap */
  thisFieldOverlaps?: boolean;
};

export function FieldTargetOverlapBannerContent({ analysis, thisFieldOverlaps }: Props) {
  if (!analysis.hasOverlap) return null;

  return (
    <BlockStack gap="300">
      <Text as="p">
        The storefront only applies one upload field per product. If several active fields share the
        same product or collection target, which one runs follows internal rules you do not control
        from this screen.
      </Text>
      <Text as="p">
        Keep a single PrintDock upload block on the product page, and make sure at most one active
        field targets each product (or collection) you care about — or accept that customers may see
        only one of those configurations.
      </Text>
      {analysis.overlappingProducts.length > 0 ? (
        <BlockStack gap="200">
          <Text as="p" fontWeight="semibold">
            Overlapping products
          </Text>
          <List type="bullet">
            {analysis.overlappingProducts.map((row) => (
              <List.Item key={row.productId}>
                <BlockStack gap="100">
                  <Text as="p">
                    {row.label === `Product ID ${row.productId}` ? (
                      <Text as="span" fontWeight="semibold">
                        {row.label}
                      </Text>
                    ) : (
                      <>
                        <Text as="span" fontWeight="semibold">
                          {row.label}
                        </Text>
                        <Text as="span" tone="subdued">{` — Product ID ${row.productId}`}</Text>
                      </>
                    )}
                  </Text>
                  <Text as="p" variant="bodySm">
                    Active fields:{" "}
                    {row.fields.map((f, index) => (
                      <span key={f.id}>
                        {index > 0 ? ", " : null}
                        <Link url={`/app/fields/${f.id}`}>{f.adminTitle}</Link>
                      </span>
                    ))}
                  </Text>
                </BlockStack>
              </List.Item>
            ))}
          </List>
        </BlockStack>
      ) : null}
      {analysis.overlappingCollections.length > 0 ? (
        <BlockStack gap="200">
          <Text as="p" fontWeight="semibold">
            Overlapping collections
          </Text>
          <List type="bullet">
            {analysis.overlappingCollections.map((row) => (
              <List.Item key={row.collectionId}>
                <BlockStack gap="100">
                  <Text as="p">
                    {row.label === `Collection ID ${row.collectionId}` ? (
                      <Text as="span" fontWeight="semibold">
                        {row.label}
                      </Text>
                    ) : (
                      <>
                        <Text as="span" fontWeight="semibold">
                          {row.label}
                        </Text>
                        <Text as="span" tone="subdued">{` — Collection ID ${row.collectionId}`}</Text>
                      </>
                    )}
                  </Text>
                  <Text as="p" variant="bodySm">
                    Active fields:{" "}
                    {row.fields.map((f, index) => (
                      <span key={f.id}>
                        {index > 0 ? ", " : null}
                        <Link url={`/app/fields/${f.id}`}>{f.adminTitle}</Link>
                      </span>
                    ))}
                  </Text>
                </BlockStack>
              </List.Item>
            ))}
          </List>
        </BlockStack>
      ) : null}
      {thisFieldOverlaps ? (
        <Text as="p" fontWeight="semibold">
          With the current targets and Active setting, this field overlaps another active field.
        </Text>
      ) : null}
    </BlockStack>
  );
}
