/**
 * Tests for the storefront error contract.
 *
 * - `publicError` must always return a 4xx response with a non-empty
 *   shopper-facing `message` and a stable `error` code.
 * - `internalError` must NEVER leak the underlying exception. The shopper
 *   sees a generic message plus a short reference id that maps to logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MESSAGES,
  internalError,
  publicError,
  type ApiErrorCode,
} from "../app/lib/api-error.server";
import { runWithRequestContext } from "../app/lib/logger.server";

/**
 * react-router's `data()` returns a `DataWithResponseInit` shape:
 *   { type: "DataWithResponseInit", data: T, init?: ResponseInit }
 * The runtime serializes that to a real Response — in unit tests we read the
 * intermediate object directly so the helpers stay free of HTTP plumbing.
 */
function readBody(result: unknown): Record<string, unknown> {
  const node = result as { data?: Record<string, unknown> };
  return node?.data ?? {};
}

function readStatus(result: unknown): number | undefined {
  const node = result as { init?: { status?: number } };
  return node?.init?.status;
}

const codes: ApiErrorCode[] = [
  "unauthorized",
  "bad_request",
  "forbidden",
  "not_found",
  "session_invalid",
  "session_expired",
  "file_unreadable",
  "file_too_large",
  "file_too_large_global",
  "extension_not_allowed",
  "max_files",
  "storage_cap_exceeded",
  "plan_required",
  "already_ordered",
  "link_invalid",
  "internal_error",
];

describe("publicError", () => {
  it.each(codes)("returns a non-empty shopper-friendly message for code %s", (code) => {
    const res = publicError(code, { status: 400 });
    const body = readBody(res);
    expect(body.error).toBe(code);
    expect(typeof body.message).toBe("string");
    expect((body.message as string).trim().length).toBeGreaterThan(10);
    // The raw snake_case code should never appear inside a shopper-visible
    // message; that's the whole point of having a separate user string.
    expect(body.message as string).not.toContain(code);
  });

  it("accepts a custom message override", () => {
    const res = publicError("file_too_large", {
      status: 402,
      message: "This file is too large. Maximum allowed: 50MB.",
    });
    expect(readStatus(res)).toBe(402);
    expect(readBody(res).message).toBe(
      "This file is too large. Maximum allowed: 50MB.",
    );
  });

  it("passes through extras (e.g. storage cap details)", () => {
    const res = publicError("storage_cap_exceeded", {
      status: 402,
      extras: { currentBytes: 1234, maxBytes: 5000, suggestedPlan: "pro" },
    });
    const body = readBody(res);
    expect(body.currentBytes).toBe(1234);
    expect(body.maxBytes).toBe(5000);
    expect(body.suggestedPlan).toBe("pro");
  });

  it("default messages never contain raw error codes", () => {
    for (const [code, message] of Object.entries(DEFAULT_MESSAGES)) {
      expect(message).not.toContain(code);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe("internalError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a 500 with a generic message and reference (no raw error text)", async () => {
    const secret = "DB_HOST=secret-db.internal port 5432";
    const fakeRequest = new Request(
      "https://shop.example.com/apps/printdock/api/proxy/upload/confirm",
      { method: "POST" },
    );

    const res = await runWithRequestContext(fakeRequest, () =>
      internalError("upload_confirm_failed", new Error(secret)),
    );

    expect(readStatus(res)).toBe(500);
    const body = readBody(res);
    expect(body.error).toBe("internal_error");
    expect(typeof body.message).toBe("string");
    expect(body.message as string).not.toContain(secret);
    expect(body.message as string).not.toContain("DB_HOST");
    expect(body.message as string).toMatch(/Reference: [a-f0-9]{8}\./);
    expect(typeof body.reference).toBe("string");
    expect((body.reference as string).length).toBe(8);
  });

  it("logs the underlying error and reference for support correlation", async () => {
    const consoleError = vi.spyOn(console, "error");
    const fakeRequest = new Request("https://shop.example.com/x", { method: "GET" });

    const res = await runWithRequestContext(fakeRequest, () =>
      internalError("upload_remove_failed", new Error("Firestore unavailable")),
    );

    const body = readBody(res);
    const reference = body.reference as string;

    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls
      .map((args) => args.join(" "))
      .join("\n");
    expect(logged).toContain("Firestore unavailable");
    expect(logged).toContain(reference);
    expect(readStatus(res)).toBe(500);
  });

  it("works outside of a request context (falls back to a random reference)", () => {
    const res = internalError("standalone_failure", new Error("boom"));
    expect(readStatus(res)).toBe(500);
    const body = readBody(res);
    expect(typeof body.reference).toBe("string");
    expect((body.reference as string).length).toBe(8);
  });
});
