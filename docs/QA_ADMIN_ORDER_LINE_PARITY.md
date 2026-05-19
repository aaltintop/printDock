# QA — Admin order line Upload Center parity (v1.0.11)

| Case | Steps | Expected |
|------|--------|----------|
| **Layout (v1.0.11)** | New order with dynamic pricing → Admin order line | `__View uploads` row **above** Part-of chevron; not nested inside Part of |
| GraphQL placement | Run query in `docs/SPIKE_ADMIN_ORDER_LINE_PROPERTIES.md` | `__View uploads` on `lineItems.nodes[].customAttributes`; not only on `lineItemGroup` |
| DevTools | Inspect `__View uploads` row | Outside Part-of container; competitor uses `s-internal-link` |
| Click `__View uploads` | Click truncated link | Download via app proxy → 302 |
| Click `View uploads` | Under Part of | Same download |
| Checkout price | Compare to in-app quote | Base + upload fee on single line |
| PrintDock job | App → Orders → job | `pricingEvidence.tokenValid: true`; `_uc_session` present on line or group props |
| Webhook | `orders/create` log | Job enqueued; no `orders_create_missing_uc_session` |
| Legacy order (pre-1.0.11) | Old order | May still show all props under Part of — expected |
| Legacy Build B cart | Two-line open cart | Fee-line transform unchanged |
| Checkout customer | Customer order status | `__uc*` hidden; `Artwork` + `View uploads` per Shopify rules |
