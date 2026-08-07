import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeOpsRequest,
  isOpsDashboardConfigured,
  opsResponseHeaders,
  opsUnauthorizedResponse,
} from "../app/services/ops-auth.server";

const SECRET = "s3cr3t-ops-token";
const previous = process.env.OPS_DASHBOARD_SECRET;

function request(headers: Record<string, string>): Request {
  return new Request("https://printdock.example/ops", { headers });
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

afterEach(() => {
  if (previous === undefined) delete process.env.OPS_DASHBOARD_SECRET;
  else process.env.OPS_DASHBOARD_SECRET = previous;
});

describe("authorizeOpsRequest", () => {
  it("accepts a matching bearer token", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    expect(authorizeOpsRequest(request({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("accepts Basic auth so a browser can reach the page", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    expect(authorizeOpsRequest(request({ authorization: basic("ops", SECRET) }))).toBe(true);
    // The username is ignored; only the password is the shared secret.
    expect(authorizeOpsRequest(request({ authorization: basic("anyone", SECRET) }))).toBe(true);
  });

  it("accepts the X-Ops-Secret header", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    expect(authorizeOpsRequest(request({ "x-ops-secret": SECRET }))).toBe(true);
  });

  it("rejects a wrong or missing credential", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    expect(authorizeOpsRequest(request({ authorization: "Bearer nope" }))).toBe(false);
    expect(authorizeOpsRequest(request({ authorization: basic("ops", "nope") }))).toBe(false);
    expect(authorizeOpsRequest(request({ "x-ops-secret": "nope" }))).toBe(false);
    expect(authorizeOpsRequest(request({}))).toBe(false);
  });

  it("rejects a malformed Basic payload instead of throwing", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    expect(authorizeOpsRequest(request({ authorization: "Basic !!!not-base64!!!" }))).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    delete process.env.OPS_DASHBOARD_SECRET;
    expect(isOpsDashboardConfigured()).toBe(false);
    expect(authorizeOpsRequest(request({ authorization: `Bearer ${SECRET}` }))).toBe(false);
    expect(authorizeOpsRequest(request({ authorization: "Bearer " }))).toBe(false);
  });

  it("treats a blank secret as unconfigured", () => {
    process.env.OPS_DASHBOARD_SECRET = "   ";
    expect(isOpsDashboardConfigured()).toBe(false);
    expect(authorizeOpsRequest(request({ "x-ops-secret": "   " }))).toBe(false);
  });
});

describe("opsUnauthorizedResponse", () => {
  it("prompts the browser with Basic for document requests", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    const response = opsUnauthorizedResponse(
      request({ accept: "text/html,application/xhtml+xml" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("stays header-free for API clients", () => {
    process.env.OPS_DASHBOARD_SECRET = SECRET;
    const response = opsUnauthorizedResponse(request({ accept: "application/json" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("says so when the dashboard has no secret configured", async () => {
    delete process.env.OPS_DASHBOARD_SECRET;
    const response = opsUnauthorizedResponse(request({}));
    await expect(response.json()).resolves.toEqual({ error: "ops_dashboard_not_configured" });
  });
});

describe("opsResponseHeaders", () => {
  it("blocks caching and indexing", () => {
    const headers = opsResponseHeaders("text/html; charset=utf-8");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  });
});
