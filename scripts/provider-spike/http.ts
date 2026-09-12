/**
 * Minimal HTTP helper for the spike: timeout + a small bounded retry for
 * transient failures (network error, 429, 5xx). This is NOT the production
 * retry/circuit-breaker system (that's Phase 4, `src/providers/http.ts`) —
 * just enough to make a handful of real calls reliable.
 */

export interface FetchJsonResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T | null;
  rawText: string;
  latencyMs: number;
  attempts: number;
}

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
  const { method = "GET", headers = {}, body, timeoutMs = 20_000, maxRetries = 2 } = options;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
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
          json = null; // non-JSON body; caller sees rawText
        }
      }

      if (isRetryableStatus(response.status) && attempt <= maxRetries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      return { status: response.status, ok: response.ok, json, rawText, latencyMs, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt <= maxRetries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `fetchJson failed after ${attempt} attempt(s) for ${safeUrlForError(url)}: ${String(lastError)}`,
  );
}

/** Strips query string from a URL before it goes into an error message —
 * some provider endpoints accept a token as a query param. */
function safeUrlForError(url: string): string {
  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex) + "?[redacted]";
}
