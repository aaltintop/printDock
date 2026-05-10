/**
 * Storefront-facing API error contract.
 *
 * Every storefront / proxy endpoint returns errors in the shape:
 *   { error: "snake_case_code", message: "Shopper-friendly text.", reference?: "abcd1234" }
 *
 * - `error`  — stable machine-readable code. Used by the client to branch
 *              (e.g. `storage_cap_exceeded`, `session_invalid`). NEVER shown
 *              to shoppers.
 * - `message` — actionable, human-readable text. ALWAYS safe to display.
 * - `reference` — present on 5xx; short prefix of the request id so support
 *                 can correlate to logs without exposing the full UUID.
 *
 * The two helpers here centralize that contract so callers cannot forget
 * the `message` field or accidentally leak `String(err)` to the storefront.
 */

import { data } from "react-router";
import { getLogContext, log } from "./logger.server";

type DataResponse<T> = ReturnType<typeof data<T>>;

export type ApiErrorCode =
  | "unauthorized"
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "session_invalid"
  | "session_expired"
  | "file_unreadable"
  | "file_too_large"
  | "file_too_large_global"
  | "extension_not_allowed"
  | "max_files"
  | "storage_cap_exceeded"
  | "plan_required"
  | "already_ordered"
  | "link_invalid"
  | "internal_error";

export interface PublicErrorBody {
  error: ApiErrorCode | string;
  message: string;
  reference?: string;
  [extra: string]: unknown;
}

/**
 * Default actionable messages for codes that do not carry dynamic context.
 * Endpoints can override by passing a custom `message` to `publicError`.
 */
export const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized:
    "We couldn't verify your session. Please refresh the page and try again.",
  bad_request:
    "We couldn't process this request. Please refresh the page and try again.",
  forbidden:
    "This action is not allowed. Please refresh the page and try again.",
  not_found:
    "We couldn't find what you were looking for. Please refresh the page and try again.",
  session_invalid:
    "Your upload session is no longer valid. Please refresh the page to start over.",
  session_expired:
    "Your upload session has expired. Please refresh the page to start a new upload.",
  file_unreadable:
    "We couldn't read this file. It may be corrupt or in an unsupported format. Please re-export and try again.",
  file_too_large:
    "This file is too large to upload. Please try a smaller file.",
  file_too_large_global:
    "This file is too large to upload. Please try a file under 500MB.",
  extension_not_allowed:
    "This file type is not allowed. Please use one of the supported formats.",
  max_files:
    "You've reached the maximum number of files for this upload.",
  storage_cap_exceeded:
    "This store has reached its upload storage limit. Please contact the merchant.",
  plan_required:
    "Uploads are temporarily unavailable for this product. Please contact the merchant.",
  already_ordered:
    "This file is part of a placed order and can no longer be removed.",
  link_invalid:
    "This download link is no longer valid. Please try again from the order page.",
  internal_error:
    "Something went wrong on our end. Please refresh the page and try again.",
};

interface PublicErrorOptions {
  /** HTTP status (default 400). */
  status?: number;
  /** Custom user-facing message; falls back to DEFAULT_MESSAGES[code]. */
  message?: string;
  /** Extra response fields (e.g. `currentBytes`, `suggestedPlan`). Never includes secrets. */
  extras?: Record<string, unknown>;
}

/**
 * Build a 4xx response with the public error contract. The returned value is
 * the result of `data()` and should be returned directly from a loader/action.
 */
export function publicError(
  code: ApiErrorCode | string,
  options: PublicErrorOptions = {},
): DataResponse<PublicErrorBody> {
  const status = options.status ?? 400;
  const message =
    options.message ?? DEFAULT_MESSAGES[code as ApiErrorCode] ?? DEFAULT_MESSAGES.bad_request;
  const body: PublicErrorBody = {
    error: code,
    message,
    ...(options.extras ?? {}),
  };
  return data(body, { status });
}

/**
 * Build a 500 response without leaking `String(err)` to the storefront.
 * Logs the underlying error with the request id and a short reference; the
 * shopper sees a generic message plus that reference so support can correlate.
 */
export function internalError(
  event: string,
  err: unknown,
  options: {
    /** Extra fields to include in the log line (request scope, ids, etc.). */
    logMeta?: Record<string, unknown>;
    /** Override the default 500 message. */
    publicMessage?: string;
  } = {},
): DataResponse<PublicErrorBody> {
  const reference = getLogContext()?.requestId?.slice(0, 8) ?? randomShortHex();
  log.error(event, err, { reference, ...(options.logMeta ?? {}) });
  const baseMessage = options.publicMessage ?? DEFAULT_MESSAGES.internal_error;
  return data(
    {
      error: "internal_error" as const,
      message: `${baseMessage} Reference: ${reference}.`,
      reference,
    },
    { status: 500 },
  );
}

function randomShortHex(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
