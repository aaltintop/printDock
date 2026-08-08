import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  renderOpsIndexHtml,
  renderOpsShopHtml,
  shortSubscriptionId,
} from "../app/services/ops-html.utils";
import {
  computeOpsTotals,
  storageCapBytesForPlan,
} from "../app/services/ops-report.utils";
import type { OpsShopRow } from "../app/services/ops-report.utils";
import { emptyUsageMonthRow } from "../app/services/ops-usage.utils";

function row(partial: Partial<OpsShopRow> & { shopDomain: string }): OpsShopRow {
  return {
    primaryDomain: null,
    planCode: "pro",
    planStatus: "active",
    planSource: "shopify",
    subscriptionId: "gid://shopify/AppSubscription/1",
    installedAt: "2026-02-01T00:00:00.000Z",
    planStartedAt: "2026-03-15T00:00:00.000Z",
    lastVerifiedAt: "2026-08-07T00:00:00.000Z",
    graceUntil: null,
    storageUsedBytes: 1_572_864,
    storageCapBytes: storageCapBytesForPlan("pro"),
    storageReconciledAt: null,
    peakStorageBytes: 2_097_152,
    avgMonthlyStorageBytes: 1_048_576,
    downloadsTotal: 431,
    downloadsThisMonth: 22,
    avgMonthlyDownloads: 37.5,
    lastDownloadAt: "2026-08-06T12:00:00.000Z",
    uploadSessionCount: 88,
    orderJobCount: 41,
    ...partial,
  };
}

const viewOptions = { months: 6, includeCounts: true, sortKey: "storage" as const };

describe("escapeHtml", () => {
  it("neutralizes markup and quotes", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("renders nullish as empty", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("shortSubscriptionId", () => {
  it("keeps only the numeric tail so the card does not overflow", () => {
    expect(shortSubscriptionId("gid://shopify/AppSubscription/43310186681")).toBe("43310186681");
    expect(shortSubscriptionId(null)).toBe("—");
    expect(shortSubscriptionId("43310186681")).toBe("43310186681");
  });
});

describe("renderOpsIndexHtml", () => {
  const shops = [row({ shopDomain: "alpha.myshopify.com" })];
  const report = {
    generatedAt: "2026-08-07T21:53:00.000Z",
    currentMonth: "2026-08",
    shops,
    monthlyTotals: [
      { month: "2026-08", downloads: 22, storageBytesMax: 2_097_152, activeShopCount: 1 },
    ],
    totals: computeOpsTotals(shops),
  };

  it("renders a full document with the client and its numbers", () => {
    const html = renderOpsIndexHtml(report, viewOptions);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("alpha.myshopify.com");
    expect(html).toContain("1.50 MB");
    expect(html).toContain("431");
    expect(html).toContain('href="https://alpha.myshopify.com"');
    expect(html).toContain('href="/ops/alpha.myshopify.com');
    expect(html).toContain("noindex");
  });

  it("shows the primary website and myshopify domain together", () => {
    const html = renderOpsIndexHtml(
      {
        ...report,
        shops: [
          row({
            shopDomain: "8cm1xx-0j.myshopify.com",
            primaryDomain: "pineappleapparels.com",
          }),
        ],
      },
      viewOptions,
    );
    expect(html).toContain("pineappleapparels.com");
    expect(html).toContain("8cm1xx-0j.myshopify.com");
    expect(html).toContain('href="https://pineappleapparels.com"');
    expect(html).toContain('href="/ops/8cm1xx-0j.myshopify.com');
    expect(html).toContain('target="_blank"');
  });

  it("escapes a shop domain that contains markup", () => {
    const html = renderOpsIndexHtml(
      {
        ...report,
        shops: [row({ shopDomain: '"><script>alert(1)</script>' })],
      },
      viewOptions,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows an empty state when no shops exist", () => {
    const html = renderOpsIndexHtml(
      { ...report, shops: [], totals: computeOpsTotals([]), monthlyTotals: [] },
      viewOptions,
    );
    expect(html).toContain("No shops in Firestore yet.");
  });
});

describe("renderOpsShopHtml", () => {
  const detail = {
    generatedAt: "2026-08-07T21:53:00.000Z",
    currentMonth: "2026-08",
    exists: true,
    row: row({ shopDomain: "alpha.myshopify.com" }),
    monthly: [
      {
        ...emptyUsageMonthRow("2026-08"),
        downloads: 22,
        downloadsByKind: { short_link: 12, proxy_token: 6, admin_order: 4 },
        storageBytesMax: 2_097_152,
        storageSamples: 7,
      },
    ],
    planHistory: [
      {
        id: "h1",
        fromPlanCode: "starter",
        fromStatus: "active",
        planCode: "pro",
        status: "active",
        source: "shopify",
        subscriptionId: "gid://shopify/AppSubscription/1",
        reconcileSource: "webhook",
        changedAt: "2026-03-15T09:00:00.000Z",
      },
    ],
  };

  it("renders monthly usage and the plan trail", () => {
    const html = renderOpsShopHtml(detail, viewOptions);
    expect(html).toContain("alpha.myshopify.com");
    expect(html).toContain("2026-08");
    expect(html).toContain("Storefront short link");
    expect(html).toContain("2026-03-15");
    expect(html).toContain("webhook");
  });

  it("links the primary website on the shop detail page", () => {
    const html = renderOpsShopHtml(
      {
        ...detail,
        row: row({
          shopDomain: "8cm1xx-0j.myshopify.com",
          primaryDomain: "pineappleapparels.com",
        }),
      },
      viewOptions,
    );
    expect(html).toContain("pineappleapparels.com");
    expect(html).toContain("8cm1xx-0j.myshopify.com");
    expect(html).toContain('href="https://pineappleapparels.com"');
    expect(html).toContain("Website");
  });

  it("flags a shop with no Firestore document", () => {
    const html = renderOpsShopHtml({ ...detail, exists: false }, viewOptions);
    expect(html).toContain("predates the hierarchy migration");
  });

  it("explains an empty plan history", () => {
    const html = renderOpsShopHtml({ ...detail, planHistory: [] }, viewOptions);
    expect(html).toContain("No recorded plan changes yet");
  });
});
