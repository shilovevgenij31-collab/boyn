/**
 * Shared production HTTP layer for provider adapters. This is NOT
 * business logic (CLAUDE.md: "the low-level client must NOT know our
 * trend/business logic") — it only knows how to make an HTTP call
 * reliable and how to turn an unsuccessful one into a safe, typed
 * ProviderError. Status-code-to-error-code mapping here is a reasonable
 * DEFAULT; an adapter that recognizes a specific vendor quirk (e.g.
 * Bright Data's "Customer is not active" arriving as a plain HTTP 400,
 * observed in Phase 1B — not a malformed-request problem at all) is
 * expected to catch and reclassify, not this module guessing vendor
 * semantics from a generic status code.
 */
import { ProviderError, type ProviderErrorCode } from "./errors.ts";

export interface ProviderFetchOptions {
  provider: string;
  operation: string;
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Total attempts including the first (Phase 4 brief §12: max 3). Set
   * to 1 to disable retries entirely — required for endpoints where a
   * client-side timeout does NOT mean the request was dropped (Bright
   * Data's /scrape: Phase 1B measured 195-370s responses against too
   * short a timeout, producing a false failure; retrying there risks
   * submitting and billing a duplicate job while the first is still
   * processing server-side). */
  maxAttempts?: number;
}

export interface ProviderFetchResult<T> {
  status: number;
  json: T | null;
  rawText: string;
  latencyMs: number;
  attempts: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 4s, 16s per attempt (Phase 4 brief §12)
const MAX_ERROR_BODY_CHARS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const base = BACKOFF_BASE_MS * 4 ** (attempt - 1); // 1s, 4s, 16s
  const jitter = Math.random() * base * 0.2;
  return base + jitter;
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // Retry-After may also be an HTTP-date; a delta from "now" is good enough here.
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) return Math.max(0, (dateMs - Date.now()) / 1000);
  return null;
}

/** Strips the query string before a URL goes into any error/log text —
 * defense in depth in case a future endpoint ever puts a token there
 * (our current Apify/Bright Data calls use an Authorization header, not
 * a query param, but this costs nothing and closes that class of leak). */
function safeUrl(url: string): string {
  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : `${url.slice(0, qIndex)}?[redacted]`;
}

function defaultErrorCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  // 402 Payment Required — Apify returns this for "not enough usage/
  // credits to run a paid actor" (Phase 8/9 hotfix, production incident:
  // this previously fell into the generic BAD_INPUT bucket below, which
  // hid a real account-quota condition from both the circuit breaker and
  // registry.ts's fallback routing).
  if (status === 402) return "QUOTA";
  if (status >= 400 && status < 500) return "BAD_INPUT";
  return "UPSTREAM";
}

/**
 * Makes one logical HTTP call with bounded retry. Throws `ProviderError`
 * (never a raw fetch/TypeError) on any terminal failure — network error,
 * timeout, or a non-2xx response after retries are exhausted. The
 * message and any embedded response body are truncated and never
 * contain request headers (Authorization is never echoed back by a
 * normal response body, but callers must still never pass a token in
 * `body`/query for this to hold).
 */
export async function providerFetch<T = unknown>(
  url: string,
  options: ProviderFetchOptions,
): Promise<ProviderFetchResult<T>> {
  const {
    provider,
    operation,
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = options;

  let attempt = 0;
  let lastNetworkError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const rawText = await response.text();
      let json: T | null = null;
      if (rawText.length > 0) {
        try {
          json = JSON.parse(rawText) as T;
        } catch {
          json = null;
        }
      }

      if (response.ok) {
        return { status: response.status, json, rawText, latencyMs, attempts: attempt };
      }

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }

      throw new ProviderError(
        defaultErrorCode(response.status),
        provider,
        operation,
        `${provider} ${operation} failed: HTTP ${response.status} at ${safeUrl(url)}: ${rawText.slice(0, MAX_ERROR_BODY_CHARS)}`,
        { httpStatus: response.status },
      );
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ProviderError) throw error; // terminal HTTP failure above — don't retry-wrap it again

      lastNetworkError = error;
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw new ProviderError(
        isAbort ? "TIMEOUT" : "UPSTREAM",
        provider,
        operation,
        `${provider} ${operation} ${isAbort ? "timed out" : "failed"} after ${attempt} attempt(s) at ${safeUrl(url)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable in practice (the loop always returns or throws), but keeps
  // the function's return type honest for TypeScript.
  throw new ProviderError(
    "UPSTREAM",
    provider,
    operation,
    `${provider} ${operation} failed after ${attempt} attempt(s) at ${safeUrl(url)}`,
    { cause: lastNetworkError },
  );
}
