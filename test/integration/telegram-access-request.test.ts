/**
 * Durable Telegram access-request/approval flow (Phase 8/9 hotfix Parts
 * H-N, production incident): env-only multi-admin required the owner to
 * manually discover a numeric Telegram id via a third-party bot before
 * granting anyone access, which never actually completed for the
 * intended second admin. This drives the REAL buildTelegramContext (a
 * fresh one per simulated incoming update, exactly like route.ts builds
 * one per webhook request) + routeUpdate against a PGlite db and a
 * recording fetch mock, so both the DB-persisted access state AND the
 * exact Telegram messages sent are verified end to end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { getEnv, resetEnvCacheForTests } from "@/config/env.ts";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { getTelegramUser } from "@/db/repositories/telegram-users.ts";
import { telegramUsers } from "@/db/schema.ts";
import type { TelegramMessage, TelegramCallbackQuery } from "@/telegram/types.ts";

const ENV_ADMIN_ID = 555000111;
const NEW_USER_ID = 700000222;
const OTHER_NEW_USER_ID = 700000333;

interface CapturedCall {
  method: string;
  body: Record<string, unknown> | null;
}

let db: TestDatabase;
let close: () => Promise<void>;
let calls: CapturedCall[];
let fetchMock: ReturnType<typeof vi.fn>;
let updateIdCounter = 0;

function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

function message(text: string, userId: number, username?: string): TelegramMessage {
  return {
    message_id: 1,
    from: { id: userId, is_bot: false, first_name: "T", ...(username !== undefined ? { username } : {}) },
    chat: { id: userId, type: "private" },
    date: 0,
    text,
  };
}

function callbackQuery(data: string, fromId: number, messageChatId: number): TelegramCallbackQuery {
  return {
    id: `cbq-${nextUpdateId()}`,
    from: { id: fromId, is_bot: false, first_name: "A" },
    message: { message_id: 1, chat: { id: messageChatId, type: "private" }, date: 0 },
    data,
  };
}

/** Every sendMessage call this test cares about, filtered by target chat_id. */
function sentTo(chatId: number): Record<string, unknown>[] {
  return calls.filter((c) => c.method === "sendMessage" && c.body?.chat_id === chatId).map((c) => c.body!);
}

async function freshCtx() {
  return buildTelegramContext(db, getEnv());
}

describe("Telegram durable access-request/approval flow (production incident regression)", () => {
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  beforeEach(() => {
    updateIdCounter = 0;
    calls = [];
    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    process.env.ADMIN_TELEGRAM_ID = String(ENV_ADMIN_ID);
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    resetEnvCacheForTests();

    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      let body: Record<string, unknown> | null = null;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = null;
        }
      }
      calls.push({ method, body });
      const resultBody =
        method === "sendMessage" || method === "editMessageText"
          ? { message_id: calls.length, chat: { id: body?.chat_id, type: "private" }, date: 0, text: body?.text ?? "" }
          : true;
      return new Response(JSON.stringify({ ok: true, result: resultBody }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ADMIN_TELEGRAM_ID;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    resetEnvCacheForTests();
    await db.delete(telegramUsers);
  });

  it("an unknown user's /start creates a PENDING request and notifies the admin with approval buttons — all in Russian", async () => {
    const ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID, "alice") });

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("PENDING");
    expect(row?.role).toBe("USER");
    expect(row?.username).toBe("alice");

    const toRequester = sentTo(NEW_USER_ID);
    expect(toRequester).toHaveLength(1);
    expect(toRequester[0]!.text).toBe("Запрос на доступ отправлен администратору.");

    const toAdmin = sentTo(ENV_ADMIN_ID);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0]!.text).toContain("Новый запрос на доступ");
    expect(toAdmin[0]!.text).toContain("@alice");
    expect(toAdmin[0]!.text).toContain(String(NEW_USER_ID));
    const keyboard = (toAdmin[0]!.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    const buttons = keyboard[0]!.map((b) => b.text);
    expect(buttons).toEqual(["✅ Разрешить", "🛡 Сделать админом", "❌ Отклонить"]);
  });

  it("a PENDING user cannot use /today yet — no data leak", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    ctx = await freshCtx(); // a fresh per-request context, exactly like a real second webhook call
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/today", NEW_USER_ID) });

    const toRequester = sentTo(NEW_USER_ID);
    expect(toRequester.at(-1)!.text).toBe("Это приватный бот. Если считаете, что у вас должен быть доступ, обратитесь к администратору.");
  });

  it("duplicate /start from the same never-decided user does not create a duplicate record or re-notify admins", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    const rows = await db.select().from(telegramUsers).where(eq(telegramUsers.userId, NEW_USER_ID));
    expect(rows).toHaveLength(1);

    const notifications = calls.filter((c) => c.method === "sendMessage" && c.body?.chat_id === ENV_ADMIN_ID && String(c.body?.text).includes("Новый запрос"));
    expect(notifications).toHaveLength(1);
  });

  it("ALLOW grants ordinary command access but not admin commands", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.role).toBe("USER");
    expect(sentTo(NEW_USER_ID).at(-1)!.text).toBe("Доступ к Trend Radar открыт.");

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/today", NEW_USER_ID) });
    expect(sentTo(NEW_USER_ID).at(-1)!.text).not.toBe("Это приватный бот. Если считаете, что у вас должен быть доступ, обратитесь к администратору.");

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/refresh tiktok", NEW_USER_ID) });
    expect(sentTo(NEW_USER_ID).at(-1)!.text).toBe("Эта команда доступна только администратору.");
  });

  it("ADMIN grants full admin command access (Part M's exact target scenario: a second admin approved without ever handling a numeric id manually)", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID, "milkatek") });

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:admin:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("ACTIVE");
    expect(row?.role).toBe("ADMIN");
    expect(sentTo(NEW_USER_ID).at(-1)!.text).toBe("Вам выданы права администратора Trend Radar.");

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/refresh tiktok", NEW_USER_ID) });
    expect(sentTo(NEW_USER_ID).at(-1)!.text).not.toBe("Эта команда доступна только администратору.");
  });

  it("DENY leaves the user denied — resubmitting /start does not re-send to admin", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:deny:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("DENIED");
    expect(sentTo(NEW_USER_ID).at(-1)!.text).toBe("Доступ к Trend Radar отклонён.");

    const adminNotifyCountBefore = calls.filter((c) => c.method === "sendMessage" && c.body?.chat_id === ENV_ADMIN_ID).length;

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });
    expect(sentTo(NEW_USER_ID).at(-1)!.text).toBe("Доступ отклонён администратором.");

    const adminNotifyCountAfter = calls.filter((c) => c.method === "sendMessage" && c.body?.chat_id === ENV_ADMIN_ID).length;
    expect(adminNotifyCountAfter).toBe(adminNotifyCountBefore); // no re-notification
  });

  it("a duplicate approval callback tap is harmless — idempotent, no duplicate notification", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    const grantedMessages = sentTo(NEW_USER_ID).filter((m) => m.text === "Доступ к Trend Radar открыт.");
    expect(grantedMessages).toHaveLength(1);
  });

  it("env bootstrap admin always works regardless of DB state (never locked out)", async () => {
    const ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/refresh tiktok", ENV_ADMIN_ID) });
    expect(sentTo(ENV_ADMIN_ID).at(-1)!.text).not.toBe("Эта команда доступна только администратору.");
  });

  it("a username change does not affect identity — access stays governed by the numeric user_id", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID, "alice") });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    // Same numeric id, now sending with a different username entirely.
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/today", NEW_USER_ID, "alice-renamed") });
    expect(sentTo(NEW_USER_ID).at(-1)!.text).not.toBe("Это приватный бот. Если считаете, что у вас должен быть доступ, обратитесь к администратору.");

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("ACTIVE"); // access untouched by the display-name change
  });

  it("the same username reused by a different user_id does not inherit access", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID, "sharedname") });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    // A different numeric id, same username string.
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", OTHER_NEW_USER_ID, "sharedname") });

    const otherRow = await getTelegramUser(db, OTHER_NEW_USER_ID);
    expect(otherRow?.status).toBe("PENDING"); // brand new request, not ACTIVE
    expect(sentTo(OTHER_NEW_USER_ID).at(-1)!.text).toBe("Запрос на доступ отправлен администратору.");
  });

  it("a non-admin's access callback is rejected and never changes the target's state", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID) });

    // Grant OTHER_NEW_USER_ID plain USER access so it can attempt the callback as a non-admin.
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", OTHER_NEW_USER_ID) });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:allow:${OTHER_NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:admin:${NEW_USER_ID}`, OTHER_NEW_USER_ID, OTHER_NEW_USER_ID) });

    const row = await getTelegramUser(db, NEW_USER_ID);
    expect(row?.status).toBe("PENDING"); // untouched — the non-admin's callback had no effect

    const answerCalls = calls.filter((c) => c.method === "answerCallbackQuery" && c.body?.text === "Эта кнопка доступна только администратору.");
    expect(answerCalls.length).toBeGreaterThan(0);
  });

  it("every access-flow message sent to any user is Russian prose (Cyrillic), never English", async () => {
    let ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", NEW_USER_ID, "alice") });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:admin:${NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/start", OTHER_NEW_USER_ID, "bob") });
    ctx = await freshCtx();
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: callbackQuery(`access:deny:${OTHER_NEW_USER_ID}`, ENV_ADMIN_ID, ENV_ADMIN_ID) });

    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body?.text));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text, `expected Cyrillic-only Russian prose, got: ${text}`).toMatch(/[А-Яа-яЁё]/);
      expect(text.toLowerCase()).not.toMatch(/\b(request|admin|denied|granted|access|pending)\b/);
    }
  });
});
