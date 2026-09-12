import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "@/providers/http.ts";
import { ProviderError, isProviderError } from "@/providers/errors.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("providerFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hello: "world" }));
    const result = await providerFetch<{ hello: string }>("https://example.com/x", {
      provider: "test",
      operation: "op",
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ hello: "world" });
    expect(result.attempts).toBe(1);
  });

  it("retries a network failure and succeeds on a later attempt", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await providerFetch("https://example.com/x", {
      provider: "test",
      operation: "op",
      maxAttempts: 3,
    });
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 and honors Retry-After", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const promise = providerFetch("https://example.com/x", { provider: "test", operation: "op", maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries 5xx errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await providerFetch("https://example.com/x", {
      provider: "test",
      operation: "op",
      maxAttempts: 3,
    });
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 (BAD_INPUT) — fails immediately", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "bad request" }));
    await expect(
      providerFetch("https://example.com/x", { provider: "test", operation: "op", maxAttempts: 3 }),
    ).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a 400 as BAD_INPUT and a 401 as AUTH", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));
    try {
      await providerFetch("https://example.com/x", { provider: "test", operation: "op" });
      expect.unreachable();
    } catch (error) {
      expect(isProviderError(error) && error.code).toBe("BAD_INPUT");
    }

    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    try {
      await providerFetch("https://example.com/y", { provider: "test", operation: "op" });
      expect.unreachable();
    } catch (error) {
      expect(isProviderError(error) && error.code).toBe("AUTH");
    }
  });

  it("respects maxAttempts: 1 (no retry at all, even for a retryable status)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    await expect(
      providerFetch("https://example.com/x", { provider: "test", operation: "op", maxAttempts: 1 }),
    ).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never leaks the request URL's query string (or anything from headers) into the error message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "bad" }));
    try {
      await providerFetch("https://example.com/x?token=super-secret-value", {
        provider: "test",
        operation: "op",
        headers: { Authorization: "Bearer super-secret-value" },
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-value");
      expect(message).toContain("[redacted]");
    }
  });

  it("times out via AbortController and classifies as TIMEOUT", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = providerFetch("https://example.com/x", {
      provider: "test",
      operation: "op",
      timeoutMs: 10,
      maxAttempts: 1,
    });
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
