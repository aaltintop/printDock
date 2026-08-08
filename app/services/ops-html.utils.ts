import type { BillingPlanHistoryEntry } from "../types/printdock";
import type { OpsMonthlyTotalRow, OpsShopRow, OpsSortKey, OpsTotals } from "./ops-report.utils";
import { formatBytes, storagePercentOfCap } from "./ops-report.utils";
import type { UsageMonthRow } from "./ops-usage.utils";
import { DOWNLOAD_KINDS, downloadKindLabel } from "./ops-usage.utils";

/**
 * Server-rendered HTML for the operator dashboard. Plain strings rather than
 * JSX because `/ops` lives outside the embedded Shopify app: no App Bridge, no
 * Polaris provider, no client bundle, and full control over status codes.
 *
 * Everything interpolated goes through `escapeHtml` — shop domains are
 * Firestore document IDs, which we treat as untrusted input.
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

export interface OpsViewOptions {
  months: number;
  includeCounts: boolean;
  sortKey: OpsSortKey;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toISOString().slice(0, 10);
}

function formatAge(iso: string | null): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const days = Math.floor((Date.now() - parsed) / 86_400_000);
  if (days < 0) return "";
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** `gid://shopify/AppSubscription/123` → `123`, so it fits in a summary card. */
export function shortSubscriptionId(gid: string | null): string {
  if (!gid) return "—";
  const tail = gid.split("/").pop()?.trim();
  return tail && tail !== "" ? tail : gid;
}

function queryString(options: OpsViewOptions, overrides: Partial<OpsViewOptions>): string {
  const merged = { ...options, ...overrides };
  const params = new URLSearchParams({
    months: String(merged.months),
    sort: merged.sortKey,
  });
  if (merged.includeCounts) params.set("counts", "1");
  return `?${params.toString()}`;
}

function card(label: string, value: string, hint?: string, valueTitle?: string): string {
  const titleAttr = valueTitle ? ` title="${escapeHtml(valueTitle)}"` : "";
  return `<div class="card">
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="card-value"${titleAttr}>${escapeHtml(value)}</div>
    ${hint ? `<div class="card-hint">${escapeHtml(hint)}</div>` : ""}
  </div>`;
}

function statusPill(status: string, source: string | null): string {
  const cls =
    status === "active" ? "pill-ok" : status === "trial" ? "pill-warn" : "pill-muted";
  const suffix = source && source !== "shopify" ? ` · ${source}` : "";
  return `<span class="pill ${cls}">${escapeHtml(status)}${escapeHtml(suffix)}</span>`;
}

function storageBar(usedBytes: number, capBytes: number): string {
  const percent = storagePercentOfCap(usedBytes, capBytes);
  const width = Math.min(100, percent);
  const cls = percent >= 90 ? "bar-danger" : percent >= 70 ? "bar-warn" : "bar-ok";
  return `<div class="bar" title="${escapeHtml(`${percent}% of ${formatBytes(capBytes)}`)}">
    <span class="bar-fill ${cls}" style="width:${width}%"></span>
  </div>
  <div class="bar-caption">${escapeHtml(formatBytes(usedBytes))} / ${escapeHtml(
    formatBytes(capBytes),
  )} · ${escapeHtml(`${percent}%`)}</div>`;
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 28px 64px;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #0f1115; color: #e6e8eb;
}
a { color: #7cc4ff; text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 32px 0 12px; text-transform: uppercase; letter-spacing: .06em; color: #9aa4b2; }
.sub { color: #9aa4b2; font-size: 13px; margin: 0 0 20px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin-bottom: 24px; font-size: 13px; }
.toolbar-group { display: flex; gap: 6px; align-items: center; }
.toolbar-label { color: #6f7885; }
.chip { padding: 3px 9px; border-radius: 999px; border: 1px solid #2a2f3a; color: #c8cfd8; }
.chip-on { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.card { background: #171a21; border: 1px solid #23272f; border-radius: 10px; padding: 14px 16px; min-width: 0; overflow: hidden; }
.card-label { color: #8b95a3; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.card-value { font-size: 22px; font-weight: 600; margin-top: 6px; overflow-wrap: anywhere; }
.card-hint { color: #6f7885; font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #23272f; vertical-align: top; }
th { color: #8b95a3; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
tbody tr:hover { background: #161a21; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.wrap { overflow-x: auto; border: 1px solid #23272f; border-radius: 10px; background: #131620; }
.muted { color: #6f7885; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.pill-ok { background: #10391f; color: #6ee7a0; }
.pill-warn { background: #3d3210; color: #f5cf6a; }
.pill-muted { background: #262a33; color: #9aa4b2; }
.plan { display: inline-block; padding: 2px 8px; border-radius: 6px; background: #1e2430; font-size: 12px; font-weight: 600; }
.bar { height: 5px; background: #262a33; border-radius: 3px; overflow: hidden; width: 130px; }
.bar-fill { display: block; height: 100%; }
.bar-ok { background: #3b82f6; } .bar-warn { background: #f59e0b; } .bar-danger { background: #ef4444; }
.bar-caption { color: #8b95a3; font-size: 11px; margin-top: 4px; white-space: nowrap; }
.empty { padding: 28px; text-align: center; color: #6f7885; }
.back { font-size: 13px; margin-bottom: 12px; display: inline-block; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body>${body}</body></html>`;
}

function toolbar(options: OpsViewOptions, jsonHref: string): string {
  const monthChoices = [3, 6, 12, 24];
  const sortChoices: Array<[OpsSortKey, string]> = [
    ["storage", "Storage"],
    ["downloads", "Downloads"],
    ["downloadsThisMonth", "Downloads (month)"],
    ["installed", "Newest install"],
    ["plan", "Plan"],
    ["shop", "Shop"],
  ];

  const months = monthChoices
    .map(
      (value) =>
        `<a class="chip ${value === options.months ? "chip-on" : ""}" href="${escapeHtml(
          queryString(options, { months: value }),
        )}">${value}m</a>`,
    )
    .join("");

  const sorts = sortChoices
    .map(
      ([key, label]) =>
        `<a class="chip ${key === options.sortKey ? "chip-on" : ""}" href="${escapeHtml(
          queryString(options, { sortKey: key }),
        )}">${escapeHtml(label)}</a>`,
    )
    .join("");

  const counts = `<a class="chip ${options.includeCounts ? "chip-on" : ""}" href="${escapeHtml(
    queryString(options, { includeCounts: !options.includeCounts }),
  )}">Upload / order counts</a>`;

  return `<div class="toolbar">
    <span class="toolbar-group"><span class="toolbar-label">Window</span>${months}</span>
    <span class="toolbar-group"><span class="toolbar-label">Sort</span>${sorts}</span>
    <span class="toolbar-group">${counts}</span>
    <span class="toolbar-group"><a href="${escapeHtml(jsonHref)}">JSON</a></span>
  </div>`;
}

function summaryCards(totals: OpsTotals, currentMonth: string): string {
  return `<div class="cards">
    ${card(
      "Clients",
      formatNumber(totals.shopCount),
      `${totals.activeCount} active · ${totals.trialCount} trial · ${totals.inactiveCount} inactive`,
    )}
    ${card(
      "Plans",
      `${totals.planCounts.pro + totals.planCounts.business} paid`,
      `free ${totals.planCounts.free} · starter ${totals.planCounts.starter} · pro ${totals.planCounts.pro} · business ${totals.planCounts.business}`,
    )}
    ${card(
      "Storage in use",
      formatBytes(totals.storageUsedBytes),
      `avg ${formatBytes(totals.avgStorageUsedBytes)} per client`,
    )}
    ${card(
      "Storage entitled",
      formatBytes(totals.storageCapBytes),
      `${storagePercentOfCap(totals.storageUsedBytes, totals.storageCapBytes)}% of sold capacity used`,
    )}
    ${card(
      "Downloads (lifetime)",
      formatNumber(totals.downloadsTotal),
      `avg ${totals.avgDownloadsPerShop} per client`,
    )}
    ${card(
      `Downloads (${currentMonth})`,
      formatNumber(totals.downloadsThisMonth),
      `avg ${totals.avgDownloadsThisMonthPerShop} per client`,
    )}
    ${card(
      "Avg downloads / month",
      String(totals.avgMonthlyDownloadsPerShop),
      "per client, completed months only",
    )}
    ${
      totals.uploadSessionCount === null
        ? card("Uploads / orders", "—", "enable upload / order counts above")
        : card(
            "Uploads / orders",
            `${formatNumber(totals.uploadSessionCount)} / ${formatNumber(
              totals.orderJobCount ?? 0,
            )}`,
            "upload sessions / order jobs",
          )
    }
  </div>`;
}

function monthlyTotalsTable(rows: OpsMonthlyTotalRow[]): string {
  if (rows.length === 0) return `<div class="wrap"><div class="empty">No usage months yet.</div></div>`;
  const body = rows
    .map(
      (row) => `<tr>
        <td class="mono">${escapeHtml(row.month)}</td>
        <td class="num">${escapeHtml(formatNumber(row.downloads))}</td>
        <td class="num">${escapeHtml(formatBytes(row.storageBytesMax))}</td>
        <td class="num">${escapeHtml(formatNumber(row.activeShopCount))}</td>
      </tr>`,
    )
    .join("");
  return `<div class="wrap"><table>
    <thead><tr>
      <th>Month (UTC)</th>
      <th class="num">Downloads</th>
      <th class="num">Peak storage (all clients)</th>
      <th class="num">Active clients</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function clientsTable(rows: OpsShopRow[], options: OpsViewOptions): string {
  if (rows.length === 0) {
    return `<div class="wrap"><div class="empty">No shops in Firestore yet.</div></div>`;
  }

  const body = rows
    .map((row) => {
      const detailHref = `/ops/${encodeURIComponent(row.shopDomain)}${queryString(options, {})}`;
      return `<tr>
        <td><a href="${escapeHtml(detailHref)}">${escapeHtml(row.shopDomain)}</a></td>
        <td><span class="plan">${escapeHtml(row.planCode)}</span><br>${statusPill(
          row.planStatus,
          row.planSource,
        )}</td>
        <td>${escapeHtml(formatDate(row.planStartedAt))}<div class="muted">${escapeHtml(
          row.planStartedAt ? formatAge(row.planStartedAt) : "never subscribed",
        )}</div></td>
        <td>${escapeHtml(formatDate(row.installedAt))}<div class="muted">${escapeHtml(
          formatAge(row.installedAt),
        )}</div></td>
        <td>${storageBar(row.storageUsedBytes, row.storageCapBytes)}</td>
        <td class="num">${escapeHtml(formatBytes(row.avgMonthlyStorageBytes))}</td>
        <td class="num">${escapeHtml(formatBytes(row.peakStorageBytes))}</td>
        <td class="num">${escapeHtml(formatNumber(row.downloadsTotal))}</td>
        <td class="num">${escapeHtml(formatNumber(row.downloadsThisMonth))}</td>
        <td class="num">${escapeHtml(String(row.avgMonthlyDownloads))}</td>
        <td>${escapeHtml(formatDate(row.lastDownloadAt))}</td>
        <td class="num">${
          row.uploadSessionCount === null
            ? '<span class="muted">—</span>'
            : escapeHtml(
                `${formatNumber(row.uploadSessionCount)} / ${formatNumber(row.orderJobCount ?? 0)}`,
              )
        }</td>
      </tr>`;
    })
    .join("");

  return `<div class="wrap"><table>
    <thead><tr>
      <th>Shop</th>
      <th>Plan</th>
      <th>On plan since</th>
      <th>Installed</th>
      <th>Storage now</th>
      <th class="num">Avg / month</th>
      <th class="num">Peak</th>
      <th class="num">Downloads</th>
      <th class="num">This month</th>
      <th class="num">Avg / month</th>
      <th>Last download</th>
      <th class="num">Uploads / orders</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

export function renderOpsIndexHtml(
  report: {
    generatedAt: string;
    currentMonth: string;
    shops: OpsShopRow[];
    monthlyTotals: OpsMonthlyTotalRow[];
    totals: OpsTotals;
  },
  options: OpsViewOptions,
): string {
  const jsonHref = `${queryString(options, {})}&format=json`;
  const body = `
    <h1>printDock ops</h1>
    <p class="sub">${escapeHtml(report.shops.length)} client(s) · generated ${escapeHtml(
      formatDateTime(report.generatedAt),
    )} · current month ${escapeHtml(report.currentMonth)}</p>
    ${toolbar(options, jsonHref)}
    ${summaryCards(report.totals, report.currentMonth)}
    <h2>Monthly totals</h2>
    ${monthlyTotalsTable(report.monthlyTotals)}
    <h2>Clients</h2>
    ${clientsTable(report.shops, options)}
  `;
  return layout("printDock ops", body);
}

function shopMonthlyTable(rows: UsageMonthRow[]): string {
  if (rows.length === 0) {
    return `<div class="wrap"><div class="empty">No usage months yet.</div></div>`;
  }
  const kindHeaders = DOWNLOAD_KINDS.map(
    (kind) => `<th class="num">${escapeHtml(downloadKindLabel(kind))}</th>`,
  ).join("");
  const body = rows
    .map(
      (row) => `<tr>
        <td class="mono">${escapeHtml(row.month)}</td>
        <td class="num">${escapeHtml(formatNumber(row.downloads))}</td>
        ${DOWNLOAD_KINDS.map(
          (kind) => `<td class="num">${escapeHtml(formatNumber(row.downloadsByKind[kind]))}</td>`,
        ).join("")}
        <td class="num">${escapeHtml(formatBytes(row.storageBytesFirst))}</td>
        <td class="num">${escapeHtml(formatBytes(row.storageBytesLast))}</td>
        <td class="num">${escapeHtml(formatBytes(row.storageBytesMax))}</td>
        <td class="num">${escapeHtml(formatNumber(row.storageSamples))}</td>
      </tr>`,
    )
    .join("");
  return `<div class="wrap"><table>
    <thead><tr>
      <th>Month (UTC)</th>
      <th class="num">Downloads</th>
      ${kindHeaders}
      <th class="num">Storage start</th>
      <th class="num">Storage end</th>
      <th class="num">Storage peak</th>
      <th class="num">Snapshots</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function planHistoryTable(entries: BillingPlanHistoryEntry[]): string {
  if (entries.length === 0) {
    return `<div class="wrap"><div class="empty">No recorded plan changes yet. History starts from the first reconcile after this feature shipped.</div></div>`;
  }
  const body = entries
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(formatDateTime(entry.changedAt))}</td>
        <td class="muted">${escapeHtml(`${entry.fromPlanCode} / ${entry.fromStatus}`)}</td>
        <td><span class="plan">${escapeHtml(entry.planCode)}</span> ${statusPill(
          entry.status,
          entry.source,
        )}</td>
        <td class="mono">${escapeHtml(entry.subscriptionId ?? "—")}</td>
        <td>${escapeHtml(entry.reconcileSource)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="wrap"><table>
    <thead><tr>
      <th>Changed at</th><th>From</th><th>To</th><th>Subscription</th><th>Trigger</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

export function renderOpsShopHtml(
  detail: {
    generatedAt: string;
    currentMonth: string;
    exists: boolean;
    row: OpsShopRow;
    monthly: UsageMonthRow[];
    planHistory: BillingPlanHistoryEntry[];
  },
  options: OpsViewOptions,
): string {
  const { row } = detail;
  const jsonHref = `${queryString(options, {})}&format=json`;
  const missing = detail.exists
    ? ""
    : `<p class="sub">No <span class="mono">shops/${escapeHtml(
        row.shopDomain,
      )}</span> document — this shop predates the hierarchy migration or was never installed.</p>`;

  const body = `
    <a class="back" href="${escapeHtml(`/ops${queryString(options, {})}`)}">← All clients</a>
    <h1>${escapeHtml(row.shopDomain)}</h1>
    <p class="sub">Generated ${escapeHtml(formatDateTime(detail.generatedAt))} · <a href="${escapeHtml(
      jsonHref,
    )}">JSON</a></p>
    ${missing}
    <div class="cards">
      ${card("Plan", row.planCode, `${row.planStatus}${row.planSource ? ` · ${row.planSource}` : ""}`)}
      ${card(
        "On plan since",
        formatDate(row.planStartedAt),
        row.planStartedAt ? formatAge(row.planStartedAt) : "never subscribed",
      )}
      ${card("Installed", formatDate(row.installedAt), formatAge(row.installedAt))}
      ${card(
        "Storage now",
        formatBytes(row.storageUsedBytes),
        `${storagePercentOfCap(row.storageUsedBytes, row.storageCapBytes)}% of ${formatBytes(
          row.storageCapBytes,
        )}`,
      )}
      ${card("Storage peak", formatBytes(row.peakStorageBytes), "highest month in window")}
      ${card("Avg storage / month", formatBytes(row.avgMonthlyStorageBytes), "completed months")}
      ${card("Downloads (lifetime)", formatNumber(row.downloadsTotal), formatAge(row.lastDownloadAt) ? `last ${formatAge(row.lastDownloadAt)}` : "no downloads yet")}
      ${card("Avg downloads / month", String(row.avgMonthlyDownloads), `${row.downloadsThisMonth} so far in ${detail.currentMonth}`)}
      ${card(
        "Uploads / orders",
        `${formatNumber(row.uploadSessionCount ?? 0)} / ${formatNumber(row.orderJobCount ?? 0)}`,
        "upload sessions / order jobs",
      )}
      ${card(
        "Subscription",
        shortSubscriptionId(row.subscriptionId),
        row.subscriptionId
          ? `verified ${formatDate(row.lastVerifiedAt)}`
          : "no Shopify subscription",
        row.subscriptionId ?? undefined,
      )}
      ${card(
        "Storage counter reconciled",
        formatDate(row.storageReconciledAt),
        row.graceUntil ? `grace until ${formatDateTime(row.graceUntil)}` : "no billing grace",
      )}
    </div>
    <h2>Monthly usage</h2>
    ${shopMonthlyTable(detail.monthly)}
    <h2>Plan history</h2>
    ${planHistoryTable(detail.planHistory)}
  `;
  return layout(`${row.shopDomain} · printDock ops`, body);
}
