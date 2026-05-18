import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type LogContext = {
  requestId: string;
  route: string;
  method: string;
  shopDomain?: string;
};

const als = new AsyncLocalStorage<LogContext>();

const LEVEL_ORDER: Record<LogSeverity, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

const SCRUB_KEY =
  /accessToken|apiSecret|password|authorization|cookie|signedUrl|presignedUrl|refreshToken|secret|api_key|apikey|token$/i;

function currentMinLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "debug") return LEVEL_ORDER.DEBUG;
  if (raw === "warn" || raw === "warning") return LEVEL_ORDER.WARNING;
  if (raw === "error") return LEVEL_ORDER.ERROR;
  return LEVEL_ORDER.INFO;
}

function shouldLog(severity: LogSeverity): boolean {
  return LEVEL_ORDER[severity] >= currentMinLevel();
}

function scrubValue(key: string, value: unknown): unknown {
  if (SCRUB_KEY.test(key)) return "[REDACTED]";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return scrubMeta(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === "object" && v !== null ? scrubMeta(v as Record<string, unknown>) : v,
    );
  }
  return value;
}

/** Shallow scrub for log meta / extras (no deep walk). */
export function scrubMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = scrubValue(k, v);
  }
  return out;
}

function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "Error", message: typeof err === "string" ? err : String(err) };
}

function basePayload(
  severity: LogSeverity,
  event: string,
  message: string,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  const ctx = als.getStore();
  const payload: Record<string, unknown> = {
    severity,
    event,
    message,
    timestamp: new Date().toISOString(),
  };
  const rid = (meta?.requestId as string | undefined) || ctx?.requestId;
  const route = (meta?.route as string | undefined) || ctx?.route;
  const method = (meta?.method as string | undefined) || ctx?.method;
  const shop = (meta?.shopDomain as string | undefined) || ctx?.shopDomain;
  if (rid) payload.requestId = rid;
  if (route) payload.route = route;
  if (method) payload.method = method;
  if (shop) payload.shopDomain = shop;
  const metaOnly = meta ? { ...meta } : {};
  delete metaOnly.requestId;
  delete metaOnly.route;
  delete metaOnly.method;
  delete metaOnly.shopDomain;
  if (Object.keys(metaOnly).length > 0) payload.meta = scrubMeta(metaOnly);
  return payload;
}

function writeLine(payload: Record<string, unknown>, severity: LogSeverity): void {
  const line = JSON.stringify(payload);
  if (severity === "ERROR" || severity === "WARNING") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function getLogContext(): LogContext | undefined {
  return als.getStore();
}

export function setLogShopDomain(shopDomain: string | undefined): void {
  const ctx = als.getStore();
  if (ctx && shopDomain) ctx.shopDomain = shopDomain;
}

/**
 * Run async work with request-scoped logging context (Cloud Logging fields: requestId, route, method, shop).
 */
export function runWithRequestContext<T>(request: Request, fn: () => T | Promise<T>): Promise<T> | T {
  const url = new URL(request.url);
  const ctx: LogContext = {
    requestId: randomUUID(),
    route: url.pathname,
    method: request.method,
  };
  return als.run(ctx, fn);
}

export const log = {
  debug(event: string, message: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("DEBUG")) return;
    writeLine(basePayload("DEBUG", event, message, meta), "DEBUG");
  },

  info(event: string, message: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("INFO")) return;
    writeLine(basePayload("INFO", event, message, meta), "INFO");
  },

  warn(event: string, message: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("WARNING")) return;
    writeLine(basePayload("WARNING", event, message, meta), "WARNING");
  },

  /** Structured error: JSON to stderr (Cloud Logging). */
  error(
    event: string,
    err: unknown,
    meta?: Record<string, unknown>,
  ): void {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    const payload = basePayload("ERROR", event, message, meta);
    payload.error = serializeError(err);
    writeLine(payload, "ERROR");
  },

  /** Business / UX events (INFO) — filter in Cloud Logging: jsonPayload.event="admin_page_view" */
  event(name: string, meta?: Record<string, unknown>): void {
    if (!shouldLog("INFO")) return;
    writeLine(basePayload("INFO", name, name, meta), "INFO");
  },
};
