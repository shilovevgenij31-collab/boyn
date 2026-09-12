/**
 * Provider-layer error taxonomy — distinct from src/lib/errors.ts's
 * AppError (which is for application/HTTP-route errors). A ProviderError
 * always carries enough safe information to decide "is this worth
 * retrying / opening the circuit for", and never carries anything secret.
 */
export type ProviderErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "QUOTA"
  | "BAD_INPUT"
  | "UPSTREAM"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "UNSUPPORTED";

export interface ProviderErrorOptions {
  httpStatus?: number;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * `message` must be a safe, human-readable summary — never interpolate a
 * raw response body, Authorization header, or URL query string into it
 * (see redactErrorText in http.ts, which every adapter routes error text
 * through before it ever reaches this constructor).
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly operation: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(
    code: ProviderErrorCode,
    provider: string,
    operation: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.operation = operation;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = options.retryable ?? defaultRetryable(code);
  }
}

/** Default retryability per code, when the caller doesn't override it —
 * matches the HTTP retry policy in http.ts (Phase 4 brief §12): network/
 * 429/5xx-shaped failures are retryable, credential/input/capability
 * problems are not (retrying them wastes a call and, for QUOTA, may waste
 * money). */
function defaultRetryable(code: ProviderErrorCode): boolean {
  switch (code) {
    case "RATE_LIMIT":
    case "UPSTREAM":
    case "TIMEOUT":
      return true;
    case "AUTH":
    case "QUOTA":
    case "BAD_INPUT":
    case "NOT_FOUND":
    case "UNSUPPORTED":
      return false;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Whether this error should count toward a circuit breaker's failure
 * tally (Phase 4 brief §17) — a malformed request or an unsupported
 * capability is OUR bug or a deliberate design choice, not the provider
 * being down, and must never trip the breaker. */
export function isCircuitEligibleFailure(error: unknown): boolean {
  if (!isProviderError(error)) return true; // unknown errors: be conservative, they might be real outages
  switch (error.code) {
    case "UPSTREAM":
    case "TIMEOUT":
    case "RATE_LIMIT":
      return true;
    case "AUTH":
    case "QUOTA":
    case "BAD_INPUT":
    case "NOT_FOUND":
    case "UNSUPPORTED":
      return false;
  }
}
