import { describe, expect, it } from "vitest";
import {
  buildShortLinkPublicUrl,
  extractShortIdFromPrintReadyUrl,
  normalizePrintReadyFileUrl,
  resolvePrintReadyPublicHost,
  sanitizePrintReadyPublicHost,
} from "../app/services/short-link.server";

describe("normalizePrintReadyFileUrl", () => {
  it("accepts a bare https app-proxy short link", () => {
    expect(
      normalizePrintReadyFileUrl(
        "https://levyapps.myshopify.com/apps/printdock/f/JDCAteQfwY",
      ),
    ).toBe("https://levyapps.myshopify.com/apps/printdock/f/JDCAteQfwY");
  });

  it("strips an accidental label prefix in the value", () => {
    expect(
      normalizePrintReadyFileUrl(
        "Print Ready File: https://levyapps.com/apps/printdock/f/AbC12",
      ),
    ).toBe("https://levyapps.com/apps/printdock/f/AbC12");
  });

  it("rejects non-https and non-printdock paths", () => {
    expect(normalizePrintReadyFileUrl("http://example.com/apps/printdock/f/x")).toBeNull();
    expect(normalizePrintReadyFileUrl("https://example.com/other")).toBeNull();
    expect(normalizePrintReadyFileUrl("not a url")).toBeNull();
  });
});

describe("buildShortLinkPublicUrl", () => {
  it("uses primary domain host when provided", () => {
    expect(
      buildShortLinkPublicUrl("levyapps.myshopify.com", "abc123XYZ0", {
        publicHost: "levyapps.com",
      }),
    ).toBe("https://levyapps.com/apps/printdock/f/abc123XYZ0");
  });

  it("falls back to myshopify domain", () => {
    expect(resolvePrintReadyPublicHost("levyapps.myshopify.com", null)).toBe(
      "levyapps.myshopify.com",
    );
    expect(buildShortLinkPublicUrl("levyapps.myshopify.com", "abc123XYZ0")).toBe(
      "https://levyapps.myshopify.com/apps/printdock/f/abc123XYZ0",
    );
  });
});

describe("extractShortIdFromPrintReadyUrl", () => {
  it("parses short id from a normalized url", () => {
    expect(
      extractShortIdFromPrintReadyUrl(
        "https://levyapps.myshopify.com/apps/printdock/f/JDCAteQfwY",
      ),
    ).toBe("JDCAteQfwY");
  });
});

describe("sanitizePrintReadyPublicHost", () => {
  it("accepts the shop myshopify host and custom domains", () => {
    expect(
      sanitizePrintReadyPublicHost("levyapps.myshopify.com", "levyapps.myshopify.com"),
    ).toBe("levyapps.myshopify.com");
    expect(sanitizePrintReadyPublicHost("www.levyapps.com", "levyapps.myshopify.com")).toBe(
      "www.levyapps.com",
    );
  });

  it("rejects other myshopify domains", () => {
    expect(sanitizePrintReadyPublicHost("evil.myshopify.com", "levyapps.myshopify.com")).toBeNull();
  });
});
