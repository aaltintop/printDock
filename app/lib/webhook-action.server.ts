/**
 * `authenticate.webhook` throws a Web `Response` for protocol outcomes (e.g. 401 invalid HMAC,
 * 400 bad payload, 405 non-POST). Those must propagate — Shopify documents 401 for bad HMAC.
 */
export function rethrowIfShopifyWebhookResponse(caught: unknown): void {
  if (caught instanceof Response) {
    throw caught;
  }
}
