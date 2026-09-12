/**
 * A small, closed set of operational error categories. This is intentionally
 * not a deep class hierarchy — see CLAUDE.md: avoid unnecessary abstraction
 * layers. The goal is only to let callers distinguish an expected, handled
 * failure (AppError) from an unexpected programmer error (TypeError and
 * friends), which should propagate and get logged loudly instead of being
 * swallowed.
 */
export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "UPSTREAM"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "CONFLICT"
  | "INTERNAL";

export interface AppErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** A known, expected operational failure. Safe to catch and report; message
 * text must never contain secrets since it may reach a JSON API response. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export interface ErrorResponseBody {
  ok: false;
  error: { code: string; message: string };
}

/** Converts any thrown value into a safe, user-facing JSON error body. Never
 * leaks stack traces or the message text of unknown (non-AppError) errors. */
export function toErrorResponse(error: unknown): ErrorResponseBody {
  if (isAppError(error)) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return { ok: false, error: { code: "INTERNAL", message: "Internal error" } };
}

const ERROR_STATUS_CODES: Record<AppErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 408,
  RATE_LIMIT: 429,
  UPSTREAM: 502,
  INTERNAL: 500,
};

/** HTTP status to use for a given error, for routes building a Response. */
export function errorStatusCode(error: unknown): number {
  return isAppError(error) ? ERROR_STATUS_CODES[error.code] : 500;
}
