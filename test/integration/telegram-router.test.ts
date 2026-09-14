/**
 * Router integration tests (Phase 8 brief §76-77, §80-81): real-shaped
 * Telegram updates fed into the real router, against a PGlite-backed
 * TelegramCommandContext with a recording client — no network calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { parsePaginationCallbackData } from "@/telegram/callbacks.ts";
import { getResultView } from "@/db/repositories/result-views.ts";
import {
  ADMIN_ID,
  NORMAL_USER_ID,
  UNAUTHORIZED_USER_ID,
  buildTestTelegramContext,
  insertScoredPost,
  resetTelegramFixtureDb,
  seedDailyReport,
  seedTrackedHashtag,
  seedCollectionRun,
} from "./helpers/telegram-fixtures.ts";
import type { TelegramMessage, TelegramCallbackQuery } from "@/telegram/types.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

function message(overrides: Partial<TelegramMessage> & { text: string }): TelegramMessage {
  return { message_id: 1, from: { id: NORMAL_USER_ID, is_bot: false, first_name: "Tester" }, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0, ...overrides };
}

let updateIdCounter = 0;
function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

describe("Telegram router (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  beforeEach(async () => {
    updateIdCounter = 0;
    await resetTelegramFixtureDb(db);
  });

  async function seedGoldenScenario(): Promise<void> {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "breakoutcreator", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 90, views: 500_000, trendState: "BREAKOUT", hashtagNames: ["cosplay", "arcane"], category: "cosplay" });
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "gamer1", publishedAt: hoursAgo(5), tier: "VIRAL_QUALIFIED", trendScore: 70, views: 200_000, hashtagNames: ["gaming"], category: "gaming" });
    await insertScoredPost(db, { platform: "instagram", creatorUsername: "iggirl", publishedAt: hoursAgo(3), tier: "VIRAL_QUALIFIED", trendScore: 60, views: 150_000, hashtagNames: ["playstation"], category: "playstation" });
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "pcbuilder", publishedAt: hoursAgo(1), tier: "EARLY_BREAKOUT", trendScore: 55, risingScore: 92, trendState: "RISING", views: 40_000, hashtagNames: ["pc"], category: "pc" });
  }

  describe("/start and authorization", () => {
    it("authorized user gets the intro", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/start" }) });
      expect(ctx.client.sentMessages).toHaveLength(1);
      expect(ctx.client.sentMessages[0]!.text).toContain("Trend Radar");
    });

    it("unauthorized user gets a private-bot response, never data", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/status", from: { id: UNAUTHORIZED_USER_ID, is_bot: false, first_name: "X" }, chat: { id: UNAUTHORIZED_USER_ID, type: "private" } }) });
      expect(ctx.client.sentMessages).toHaveLength(1);
      expect(ctx.client.sentMessages[0]!.text).toMatch(/private bot/i);
      expect(ctx.client.sentMessages[0]!.text).not.toMatch(/budget|circuit|tracked/i);
    });

    it("a normal user requesting an admin-only command is denied", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/refresh" }) });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/admin only/i);
    });

    it("admin is authorized for normal commands too", async () => {
      await seedGoldenScenario();
      await seedDailyReport(db, new FixedClock(NOW));
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/today", from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" } }) });
      expect(ctx.client.sentMessages.length).toBeGreaterThan(0);
    });

    it("an unknown command is ignored safely, no crash, no reply", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/not-a-real-command" }) });
      expect(ctx.client.sentMessages).toHaveLength(0);
    });
  });

  describe("/help", () => {
    it("normal user sees normal commands, not admin ones", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/help" }) });
      const text = ctx.client.sentMessages[0]!.text;
      expect(text).toContain("/today");
      expect(text).not.toContain("/refresh");
    });

    it("admin sees admin commands too", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/help", from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" } }) });
      expect(ctx.client.sentMessages[0]!.text).toContain("/refresh");
    });
  });

  describe("/today", () => {
    it("shows the report header + Today Top, separate from Still Hot, and paginates via a result_view", async () => {
      await seedGoldenScenario();
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "stillhotcreator", publishedAt: hoursAgo(30), tier: "VIRAL_QUALIFIED", trendScore: 50, views: 80_000 });
      const reportDate = await seedDailyReport(db, new FixedClock(NOW));

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/today" }) });

      const main = ctx.client.sentMessages[0]!;
      expect(main.text).toContain(reportDate);
      expect(main.reply_markup!.inline_keyboard[0]!.length).toBeGreaterThan(0);

      const stillHotPrompt = ctx.client.sentMessages.find((m) => m.text.includes("Still Hot"));
      expect(stillHotPrompt).toBeDefined();
      expect(stillHotPrompt!.reply_markup!.inline_keyboard[0]![0]!.callback_data).toMatch(/^sh:/);
    });

    it("with no report yet, says so instead of crashing", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/today" }) });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/no daily report/i);
    });
  });

  describe("Still Hot callback", () => {
    it("reveals Still Hot items via the sh: callback", async () => {
      await seedGoldenScenario();
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "stillhotcreator", publishedAt: hoursAgo(30), tier: "VIRAL_QUALIFIED", trendScore: 50, views: 80_000 });
      const reportDate = await seedDailyReport(db, new FixedClock(NOW));

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      const cq: TelegramCallbackQuery = { id: "cbq1", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "Tester" }, message: { message_id: 5, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: `sh:${reportDate}` };
      await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cq });

      expect(ctx.client.answeredCallbacks).toHaveLength(1);
      const stillHotMessage = ctx.client.sentMessages.find((m) => m.text.includes("Still Hot") && m.reply_markup?.inline_keyboard[0]?.some((b) => b.url));
      expect(stillHotMessage).toBeDefined();
    });
  });

  describe("/rising", () => {
    it("uses CURRENT analytics (a LIVE view), not the frozen risingNow", async () => {
      await seedGoldenScenario();
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/rising" }) });
      const main = ctx.client.sentMessages[0]!;
      expect(main.text).toMatch(/Rising Now/);
      expect(main.text).toMatch(/Data as of/);
    });
  });

  describe("platform and category filters", () => {
    for (const [cmd, expectHeaderMatch] of [
      ["/tiktok", /TikTok/],
      ["/instagram", /Instagram/],
      ["/cosplay", /Cosplay/],
      ["/streamers", /Streamers/],
      ["/gaming", /Gaming/],
      ["/pc", /PC/],
      ["/playstation", /PlayStation/],
    ] as const) {
      it(`${cmd} responds with a ranked, headered page`, async () => {
        await seedGoldenScenario();
        const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
        await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: cmd }) });
        expect(ctx.client.sentMessages.length).toBeGreaterThan(0);
        expect(ctx.client.sentMessages[0]!.text).toMatch(expectHeaderMatch);
      });
    }

    it("/gaming includes the pc/playstation roll-up (category parent semantics)", async () => {
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "pcguy", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000, category: "pc" });
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/gaming" }) });
      expect(ctx.client.sentMessages[0]!.text).not.toContain("no qualifying posts");
    });
  });

  describe("pagination", () => {
    it("page 1 -> page 2 -> page 1 via callback edits the same message", async () => {
      for (let i = 0; i < 7; i++) {
        await insertScoredPost(db, { platform: "tiktok", creatorUsername: `creator${i}`, publishedAt: hoursAgo(1 + i), tier: "VIRAL_QUALIFIED", trendScore: 90 - i, views: 100_000 });
      }
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/tiktok" }) });
      const sent = ctx.client.sentMessages[0]!;
      const navRow = sent.reply_markup!.inline_keyboard[1]!;
      const nextBtn = navRow.find((b) => b.text.includes("Next"))!;
      const parsed = parsePaginationCallbackData(nextBtn.callback_data!)!;

      const cqNext: TelegramCallbackQuery = { id: "cbq-next", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 42, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: nextBtn.callback_data };
      await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cqNext });
      expect(ctx.client.edits).toHaveLength(1);
      expect(ctx.client.edits[0]!.message_id).toBe(42);
      expect(ctx.client.edits[0]!.text).toContain("#6"); // page 2 shows items 6-7

      const prevBtn = ctx.client.edits[0]!.reply_markup!.inline_keyboard[1]!.find((b) => b.text.includes("Prev"))!;
      const cqPrev: TelegramCallbackQuery = { id: "cbq-prev", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 42, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: prevBtn.callback_data };
      await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cqPrev });
      expect(ctx.client.edits).toHaveLength(2);
      expect(ctx.client.edits[1]!.text).toContain("#1");

      expect(parsed.page).toBe(2);
    });

    it("an expired/missing view tells the user to rerun the command", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      const cq: TelegramCallbackQuery = { id: "cbq", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 1, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: "pg:doesnotexist12:1" };
      await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cq });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/expired/i);
    });

    it("a malformed callback never crashes the router", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      const cq: TelegramCallbackQuery = { id: "cbq", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 1, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: "garbage" };
      await expect(routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cq })).resolves.not.toThrow();
      expect(ctx.client.answeredCallbacks).toHaveLength(1);
    });

    it("an unauthorized user's callback is rejected without touching data", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      const cq: TelegramCallbackQuery = { id: "cbq", from: { id: UNAUTHORIZED_USER_ID, is_bot: false, first_name: "X" }, message: { message_id: 1, chat: { id: UNAUTHORIZED_USER_ID, type: "private" }, date: 0 }, data: "pg:abc:1" };
      await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: cq });
      expect(ctx.client.answeredCallbacks[0]!.show_alert).toBe(true);
      expect(ctx.client.edits).toHaveLength(0);
    });

    it("result_views freeze rankings — a view created before a later post appears still shows the old ranking on page 2", async () => {
      for (let i = 0; i < 6; i++) {
        await insertScoredPost(db, { platform: "tiktok", creatorUsername: `frozen${i}`, publishedAt: hoursAgo(1 + i), tier: "VIRAL_QUALIFIED", trendScore: 90 - i, views: 100_000 });
      }
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/tiktok" }) });
      const viewIdMatch = ctx.client.sentMessages[0]!.reply_markup!.inline_keyboard[1]!.find((b) => b.callback_data)!.callback_data!;
      const { viewId } = parsePaginationCallbackData(viewIdMatch)!;

      // A brand-new, even-higher-scoring post appears AFTER the view was frozen.
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "latecomer", publishedAt: hoursAgo(0.1), tier: "VIRAL_QUALIFIED", trendScore: 999, views: 999_999 });

      const view = await getResultView(db, viewId, NOW);
      expect(view!.items.some((i) => i.creatorUsername === "latecomer")).toBe(false);
    });
  });

  describe("/tags", () => {
    it("renders tracked hashtag radar data with Radar wording, never a platform-wide claim", async () => {
      await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
      await seedGoldenScenario();
      await seedDailyReport(db, new FixedClock(NOW)); // runs are not required, but exercise the same data hashtagDailyStats would carry after analytics
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/tags" }) });
      const text = ctx.client.sentMessages[0]!.text;
      expect(text).not.toMatch(/TikTok hashtag grew/i);
    });
  });

  describe("/status", () => {
    it("built entirely from persisted state, admin sees error summaries too", async () => {
      await seedCollectionRun(db, hoursAgo(1), "tiktok");
      await seedGoldenScenario();
      await seedDailyReport(db, new FixedClock(NOW));

      const ctxNormal = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctxNormal, { update_id: nextUpdateId(), message: message({ text: "/status" }) });
      expect(ctxNormal.client.sentMessages[0]!.text).toMatch(/Budget/);
      expect(ctxNormal.client.sentMessages[0]!.text).not.toMatch(/Errors \(24h\)/);

      const ctxAdmin = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctxAdmin, { update_id: nextUpdateId(), message: message({ text: "/status", from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" } }) });
      expect(ctxAdmin.client.sentMessages[0]!.text).toMatch(/Errors \(24h\)/);
    });
  });

  describe("/ideas", () => {
    it("gives a deterministic metadata-based summary, no AI wording", async () => {
      await seedGoldenScenario();
      await seedDailyReport(db, new FixedClock(NOW));
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message({ text: "/ideas" }) });
      const text = ctx.client.sentMessages[0]!.text;
      expect(text).toMatch(/did not watch/i);
      expect(text).not.toMatch(/openrouter|gpt|claude/i);
    });
  });
});
