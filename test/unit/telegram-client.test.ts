/**
 * Telegram Bot API client (Phase 8 brief §15, §79) — mocked fetch, no
 * network. Verifies retry policy and that the token never leaks into a
 * thrown error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramClient } from "@/telegram/client.ts";
import { isTelegramError } from "@/telegram/errors.ts";

const TOKEN = "123456:AAsecret-token-value";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createTelegramClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the result on a 200 ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { id: 1, is_bot: true, first_name: "Bot", username: "iiinstttta_bot" } }));
    const client = createTelegramClient(TOKEN);
    const me = await client.getMe();
    expect(me.username).toBe("iiinstttta_bot");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400 (deterministic request error)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    const client = createTelegramClient(TOKEN);
    await expect(client.sendMessage({ chat_id: 1, text: "hi" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a short 429 (retry_after <= 10s) and succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { ok: false, error_code: 429, parameters: { retry_after: 2 } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } }));

    const client = createTelegramClient(TOKEN);
    const promise = client.sendMessage({ chat_id: 1, text: "hi" });
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;

    expect(result.message_id).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a long 429 (retry_after > 10s) becomes a typed RATE_LIMIT_DEFERRED, no retry loop", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { ok: false, error_code: 429, parameters: { retry_after: 60 } }));
    const client = createTelegramClient(TOKEN);
    const error = await client.sendMessage({ chat_id: 1, text: "hi" }).catch((e: unknown) => e);
    expect(isTelegramError(error)).toBe(true);
    if (isTelegramError(error)) {
      expect(error.code).toBe("RATE_LIMIT_DEFERRED");
      expect(error.retryAfterSec).toBe(60);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx up to the bounded maximum", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { ok: false })).mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 2, chat: { id: 1, type: "private" }, date: 0 } }));

    const client = createTelegramClient(TOKEN);
    const promise = client.sendMessage({ chat_id: 1, text: "hi" });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.message_id).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts of persistent 5xx failures", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(503, { ok: false }));
    const client = createTelegramClient(TOKEN);
    const promise = client.sendMessage({ chat_id: 1, text: "hi" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;
    expect(isTelegramError(error)).toBe(true);
    if (isTelegramError(error)) expect(error.code).toBe("SERVER_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a network failure and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { message_id: 3, chat: { id: 1, type: "private" }, date: 0 } }));

    const client = createTelegramClient(TOKEN);
    const promise = client.sendMessage({ chat_id: 1, text: "hi" });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.message_id).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never leaks the bot token in a thrown error's message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { ok: false, description: "Bad Request" }));
    const client = createTelegramClient(TOKEN);
    const error = await client.sendMessage({ chat_id: 1, text: "hi" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain("api.telegram.org");
  });
});
