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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/telegram/webhook/route.ts";
import { resetEnvCacheForTests } from "@/config/env.ts";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { tryClaimUpdate } from "@/db/repositories/telegram-updates.ts";

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
});
