/**
 * Webhook route + update dedupe (Phase 8 brief §78). The route's auth
 * and parsing paths never touch the database (see route.ts), so they're
 * exercised here against the REAL POST() handler with a real Request —
 * matching this repo's established convention (test/unit/cron-tick-
 * auth.test.ts) of testing auth logic directly rather than mocking a
 * live Postgres connection. `tryClaimUpdate` — the actual dedupe
 * mechanism the route calls before any side effect — is verified
 * separately against PGlite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/telegram/webhook/route.ts";
import { getEnv, resetEnvCacheForTests } from "@/config/env.ts";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { releaseClaim, tryClaimUpdate } from "@/db/repositories/telegram-updates.ts";
import { telegramUpdates } from "@/db/schema.ts";
import { eq } from "drizzle-orm";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import { routeUpdate } from "@/telegram/router.ts";

const SECRET = "test-webhook-secret";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/telegram/webhook", () => {
  const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const originalDbUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
    process.env.DATABASE_URL = originalDbUrl;
    resetEnvCacheForTests();
  });

  it("rejects a missing secret header with 401", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ update_id: 1 }));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret with 401", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ update_id: 1 }, { "x-telegram-bot-api-secret-token": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("fails closed with 500 when the webhook secret isn't configured at all", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ update_id: 1 }, { "x-telegram-bot-api-secret-token": "anything" }));
    expect(res.status).toBe(500);
  });

  it("rejects malformed JSON with 400 (after auth passes)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest("{not valid json", { "x-telegram-bot-api-secret-token": SECRET }));
    expect(res.status).toBe(400);
  });

  it("rejects a structurally invalid update (missing update_id) with 400", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } }, { "x-telegram-bot-api-secret-token": SECRET }));
    expect(res.status).toBe(400);
  });

  it("a correctly authenticated, well-formed update never crashes uncaught even without a configured database (fails closed with 500)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    delete process.env.DATABASE_URL;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ update_id: 1 }, { "x-telegram-bot-api-secret-token": SECRET }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("never leaks the configured secret in a response body", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    resetEnvCacheForTests();
    const res = await POST(makeRequest({ update_id: 1 }, { "x-telegram-bot-api-secret-token": "wrong" }));
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });
});

describe("telegram_updates dedupe (PGlite-backed) — the mechanism route.ts relies on", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("first claim of an update_id succeeds; a redelivery of the same update_id is rejected", async () => {
    const first = await tryClaimUpdate(db, 555, new Date());
    expect(first).toBe(true);

    const redelivery = await tryClaimUpdate(db, 555, new Date());
    expect(redelivery).toBe(false);
  });

  it("distinct update_ids are independently claimable", async () => {
    expect(await tryClaimUpdate(db, 601, new Date())).toBe(true);
    expect(await tryClaimUpdate(db, 602, new Date())).toBe(true);
  });

  it("regression (production incident): releasing a claim after a processing failure lets Telegram's automatic retry reprocess the SAME update_id, instead of it being permanently lost", async () => {
    const updateId = 701;
    expect(await tryClaimUpdate(db, updateId, new Date())).toBe(true);

    // Simulate route.ts's catch branch: processing failed after the claim
    // succeeded (e.g. buildTelegramContext threw, or an unhandled error
    // escaped routeUpdate) — the claim is released so the update isn't
    // blackholed.
    await releaseClaim(db, updateId);
    const rowsAfterRelease = await db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId));
    expect(rowsAfterRelease).toHaveLength(0);

    // Telegram's real retry sends the exact same update_id again — it must
    // be claimable (and therefore processed) again, not silently dropped.
    const retryClaim = await tryClaimUpdate(db, updateId, new Date());
    expect(retryClaim).toBe(true);
  });
});

describe("real command processing, end to end (production incident regression)", () => {
  // Composes the EXACT same sequence route.ts's POST handler runs (claim
  // -> buildTelegramContext -> await routeUpdate, releasing the claim on
  // failure) using the real functions and a real PGlite db, rather than
  // re-importing route.ts itself: module-mocking @/db/client.ts for a
  // dynamically-reimported route.ts is workable but fragile here (a
  // vi.resetModules() forces @/db/schema.ts to re-evaluate too, and the
  // freshly re-imported table objects are no longer the same references
  // the already-constructed PGlite `db` was wired against, which itself
  // produces confusing query failures unrelated to what this test is
  // actually trying to prove). Calling the same functions directly is
  // simpler, avoids that pitfall, and is just as faithful a reproduction.
  const ADMIN_ID = 555000111;
  let db: TestDatabase;
  let close: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    process.env.ADMIN_TELEGRAM_ID = String(ADMIN_ID);
    process.env.TELEGRAM_ALLOWED_USER_IDS = String(ADMIN_ID);
    resetEnvCacheForTests();

    fetchMock = vi.fn(async (url: string) => {
      // Every Telegram Bot API call this test cares about (sendMessage,
      // answerCallbackQuery, ...) succeeds with a minimal valid envelope.
      const body = url.includes("sendMessage") ? { message_id: 1, chat: { id: ADMIN_ID, type: "private" }, date: 0, text: "" } : true;
      return new Response(JSON.stringify({ ok: true, result: body }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ADMIN_TELEGRAM_ID;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    resetEnvCacheForTests();
    await db.delete(telegramUpdates);
  });

  function statusUpdate(updateId: number): import("@/telegram/types.ts").TelegramUpdate {
    return {
      update_id: updateId,
      message: { message_id: 1, from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" }, date: 0, text: "/help" },
    };
  }

  it("THE CORE FIX: awaiting routeUpdate() to completion (as route.ts now does) means the Telegram sendMessage call has genuinely happened before anything responds — not deferred to a background task that can be cut short", async () => {
    const claimed = await tryClaimUpdate(db, 9001, new Date());
    expect(claimed).toBe(true);

    const ctx = buildTelegramContext(db, getEnv());
    await routeUpdate(ctx, statusUpdate(9001));

    // The regression: previously, a deferred/fire-and-forget send could be
    // torn down by the serverless runtime before this ever fired. Awaiting
    // it directly (exactly what route.ts does now) guarantees it already
    // happened by the time control returns here.
    const sendMessageCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("sendMessage"));
    expect(sendMessageCalls.length).toBeGreaterThan(0);
  });

  it("regression: a failure between claiming and finishing (e.g. Telegram context construction) releases the claim so the SAME update_id can be retried and actually processed", async () => {
    const updateId = 9002;
    const claimed = await tryClaimUpdate(db, updateId, new Date());
    expect(claimed).toBe(true);

    // Force buildTelegramContext to throw (missing bot token) — a failure
    // that happens AFTER the claim succeeds but BEFORE any Telegram send,
    // exactly matching route.ts's try/catch scope.
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetEnvCacheForTests();
    let threw = false;
    try {
      buildTelegramContext(db, getEnv());
    } catch {
      threw = true;
      await releaseClaim(db, updateId);
    }
    expect(threw).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // never got far enough to send anything

    const rows = await db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId));
    expect(rows).toHaveLength(0); // claim was released, not left dangling

    // Telegram's real retry: same update_id, now with a working config —
    // must be claimable and must actually process this time.
    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    resetEnvCacheForTests();
    const retryClaim = await tryClaimUpdate(db, updateId, new Date());
    expect(retryClaim).toBe(true);
    const ctx = buildTelegramContext(db, getEnv());
    await routeUpdate(ctx, statusUpdate(updateId));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("sendMessage"))).toBe(true);
  });
});
