# SPIKE: Shopify Admin order line property linkification

**Date:** 2026-05-19 (updated 2026-05-20)  
**Status:** Implementation shipped — verify on dev store after `shopify app deploy`

## Question

Which line item property key/value makes Shopify Admin show a **clickable truncated** upload link like Upload Center’s `__View uploads: silverbeauty-2.myshopify.com...` **above** Part of?

## Finding: parent vs `lineItemGroup` (root cause)

| Observation | Upload Center | PrintDock (before v1.0.11) |
|-------------|---------------|----------------------------|
| Admin layout | `__View uploads` **above** Part-of chevron (`s-internal-link`) | `__View uploads` **inside** Part-of block |
| Cart Transform | Unknown (likely same split) | `ExpandedItem.attributes: None` → all props under Part of |

**Fix (v1.0.11):** [`extensions/auto-pricing-rs/src/main.rs`](../extensions/auto-pricing-rs/src/main.rs) sets `ExpandedItem.attributes` to View uploads, Artwork, `_uc_session` only (v1.0.12+ no longer copies `__ucToken` / `__ucExp`). **`__View uploads` is excluded** so it remains on the parent cart line.

Shopify documents assigning bundle vs component attributes via [Cart Transform Expand (2024-04)](https://shopify.dev/changelog/set-lineitem-attributes-using-carttransform).

## Manual GraphQL verification (run after deploy)

```graphql
query OrderLineAttributePlacement($id: ID!) {
  order(id: $id) {
    lineItems(first: 20) {
      nodes {
        title
        customAttributes { key value }
        lineItemGroup {
          title
          customAttributes { key value }
        }
      }
    }
  }
}
```

| Key | UC: parent? | UC: group? | PD (new order): parent? | PD: group? |
|-----|-------------|------------|-------------------------|------------|
| `__View uploads` | fill in | fill in | **expect yes** | **expect no** |
| `View uploads` | fill in | fill in | optional | **expect yes** |
| `_uc_session` | fill in | fill in | optional | **expect yes** |

**Pass:** PD `__View uploads` only on `lineItems.nodes[].customAttributes`. Admin DevTools: `__View uploads` row is **not** inside the Part-of collapsible section.

## `s-internal-link` HTML (competitor)

Admin renders:

```html
<s-internal-text>__View uploads:</s-internal-text>
<s-internal-link accessibilitylabel="Link for __View uploads">silverbeauty-2.myshopify.com...</s-internal-link>
```

Requires `__View uploads` on the **parent** line with a full `https://` URL value (truncation is Admin UI only).

## Decisions

1. **`__View uploads`** + **`View uploads`**: same short URL at cart add.
2. **Component bucket** (Part of): View uploads, Artwork, `_uc_session`.
3. **Parent bucket**: `__View uploads` only (for Admin top link).
4. **`partOfTitle`**: cart `_pd_price_map` JSON only (not a line property).

## Fallback

**More actions → PrintDock files** if parent link still missing on a store.
