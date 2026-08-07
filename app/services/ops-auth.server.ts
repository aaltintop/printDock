import { createHash, timingSafeEqual } from "crypto";

/**
 * Auth for the operator dashboard (`/ops`). Same shared-secret model as the
 * cron routes, plus HTTP Basic so a browser can reach the page without the
 * secret ever landing in a URL, browser history, or access log.
 *
 * Accepted, in order:
 *   Authorization: Bearer <OPS_DASHBOARD_SECRET>
 *   Authorization: Basic base64("ops:<OPS_DASHBOARD_SECRET>")   ← browser prompt
 *   X-Ops-Secret: <OPS_DASHBOARD_SECRET>
 */

const BASIC_REALM = 'Basic realm="printDock Ops", charset="UTF-8"';

function configuredSecret(): string | null {
  const secret = process.env.OPS_DASHBOARD_SECRET?.trim();
  return secret ? secret : null;
}

/** Compare digests so the check does not leak the secret's length. */
function secretMatches(candidate: string, secret: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function passwordFromBasic(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator === -1 ? decoded : decoded.slice(separator + 1);
  } catch {
    return null;
  }
}

export function isOpsDashboardConfigured(): boolean {
  return configuredSecret() !== null;
}

export function authorizeOpsRequest(request: Request): boolean {
  const secret = configuredSecret();
  if (!secret) return false;

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (authorization.startsWith("Bearer ")) {
    return secretMatches(authorization.slice(7).trim(), secret);
  }
  if (authorization.startsWith("Basic ")) {
    const password = passwordFromBasic(authorization.slice(6).trim());
    return password !== null && secretMatches(password, secret);
  }

  const headerSecret = request.headers.get("x-ops-secret")?.trim();
  if (headerSecret) return secretMatches(headerSecret, secret);

  return false;
}

/** Headers every ops response carries: never cached, never indexed. */
export function opsResponseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  };
}

/**
 * 401 that triggers the browser's Basic prompt for document requests while
 * staying machine-readable for `curl`.
 */
export function opsUnauthorizedResponse(request: Request): Response {
  const accept = request.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");
  const headers = opsResponseHeaders("application/json; charset=utf-8");
  const body = isOpsDashboardConfigured()
    ? { error: "unauthorized" }
    : { error: "ops_dashboard_not_configured" };

  return new Response(JSON.stringify(body), {
    status: 401,
    headers: wantsHtml ? { ...headers, "www-authenticate": BASIC_REALM } : headers,
  });
}
