/**
 * Repository-wide "no leftover English UI text" regression test (Phase
 * 8/9 hotfix Part G production incident: an earlier localization pass
 * missed deliver-report.ts entirely — a separate, never-reused render
 * path for the automatic daily delivery — leaving raw English strings
 * like "Today Top 12" and "15 more posts are Still Hot (24-72h old) —
 * send /today again and tap 'Show Still Hot' to see them." live in
 * production). Drives the REAL router + REAL deliverDailyReport against
 * a PGlite-backed context and scans every actually-sent message/button
 * text against a curated forbidden-phrase list — this is deliberately a
 * text SCAN, not a per-command content assertion (those already exist in
 * telegram-router.test.ts / telegram-admin.test.ts), so it catches any
 * future re-introduction of English copy anywhere in the render surface.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { deliverDailyReport } from "@/telegram/deliver-report.ts";
import {
  ADMIN_ID,
  NORMAL_USER_ID,
  buildTestTelegramContext,
  insertScoredPost,
  resetTelegramFixtureDb,
  seedCollectionRun,
  seedDailyReport,
  seedTrackedHashtag,
} from "./helpers/telegram-fixtures.ts";
import type { TelegramMessage, TelegramCallbackQuery } from "@/telegram/types.ts";

const NOW = new Date("2026-09-24T12:00:00.000Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

/** Curated from the exact strings named in the production incident plus
 * every generic English UI word this bot used before localization. Each
 * entry is a case-insensitive whole-phrase match against rendered text —
 * deliberately NOT matching bare platform names (TikTok/Instagram) or
 * command identifiers (/today, /refresh, ...), which stay English/Latin
 * by design. */
const FORBIDDEN_ENGLISH_PHRASES: RegExp[] = [
  /today top/i,
  /still hot/i,
  /show still hot/i,
  /send \/today again/i,
  /rising now/i,
  /data as of/i,
  /private bot/i,
  /admin only/i,
  /no daily report/i,
  /this view has expired/i,
  /not authorized/i,
  /something went wrong/i,
  /no qualifying posts/i,
  /\bbudget\b/i,
  /errors \(24h\)/i,
  /did not watch/i,
  /\bcooldown\b/i,
  /already tracked/i,
  /not tracked/i,
  /already dormant\b.*report/i,
  /no post at rank/i,
  /accepted\b/i,
  /no due hashtags/i,
  /budget exhausted/i,
  /\bpaused\b/i,
  /no provider currently available/i,
];

let updateIdCounter = 0;
function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

function message(text: string, userId: number): TelegramMessage {
  return { message_id: 1, from: { id: userId, is_bot: false, first_name: "T" }, chat: { id: userId, type: "private" }, date: 0, text };
}

function assertNoForbiddenEnglish(texts: string[]): void {
  for (const text of texts) {
    for (const pattern of FORBIDDEN_ENGLISH_PHRASES) {
      expect(text, `forbidden English phrase ${pattern} found in: ${text}`).not.toMatch(pattern);
    }
  }
}

describe("no leftover English UI text (repository-wide scan, production incident regression)", () => {
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

  it("scans every public + admin command, pagination, callbacks, and the automatic delivery path", async () => {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000, category: "cosplay" });
    await insertScoredPost(db, { platform: "instagram", creatorUsername: "b", publishedAt: hoursAgo(3), tier: "VIRAL_QUALIFIED", trendScore: 60, views: 50_000, category: "gaming" });
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "stillhotcreator", publishedAt: hoursAgo(30), tier: "VIRAL_QUALIFIED", trendScore: 50, views: 80_000 });
    await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
    // A real FAILED provider_jobs row makes the report genuinely PARTIAL
    // with a real "tiktok:discovery_failed" partialReason — the exact
    // presentation-mapping path Part F fixed.
    await seedCollectionRun(db, hoursAgo(1), "tiktok", "FAILED");
    const reportDate = await seedDailyReport(db, new FixedClock(NOW));

    const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
    const texts: string[] = [];
    const collect = () => {
      for (const m of ctx.client.sentMessages) texts.push(m.text);
      for (const m of ctx.client.sentMessages) {
        for (const row of m.reply_markup?.inline_keyboard ?? []) {
          for (const btn of row) texts.push(btn.text);
        }
      }
      for (const e of ctx.client.edits) texts.push(e.text);
    };

    const normalCommands = ["/start", "/help", "/today", "/rising", "/tiktok", "/instagram", "/cosplay", "/streamers", "/gaming", "/pc", "/playstation", "/tags", "/status", "/ideas"];
    for (const cmd of normalCommands) {
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message(cmd, NORMAL_USER_ID) });
    }

    const adminCommands = ["/help", "/status", "/refresh tiktok", "/track tiktok #newtag", "/track tiktok #newtag", "/untrack tiktok #newtag", "/why 1", "/why 999"];
    for (const cmd of adminCommands) {
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: message(cmd, ADMIN_ID) });
    }

    // Still Hot callback + pagination + expired/malformed callbacks.
    const shCq: TelegramCallbackQuery = { id: "cbq-sh", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 5, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: `sh:${reportDate}` };
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: shCq });
    const expiredCq: TelegramCallbackQuery = { id: "cbq-exp", from: { id: NORMAL_USER_ID, is_bot: false, first_name: "T" }, message: { message_id: 1, chat: { id: NORMAL_USER_ID, type: "private" }, date: 0 }, data: "pg:doesnotexist12:1" };
    await routeUpdate(ctx, { update_id: nextUpdateId(), callback_query: expiredCq });

    // Unauthorized user path.
    await routeUpdate(ctx, { update_id: nextUpdateId(), message: message("/status", 424242) });

    collect();

    // The automatic daily-delivery path — a SEPARATE render path from
    // the interactive commands above (this is exactly what previously
    // diverged and leaked English).
    const deliveryCtx = buildTestTelegramContext(db, new FixedClock(NOW), { reportChatId: 999888 });
    await deliverDailyReport(deliveryCtx, reportDate);
    for (const m of deliveryCtx.client.sentMessages) texts.push(m.text);
    for (const m of deliveryCtx.client.sentMessages) {
      for (const row of m.reply_markup?.inline_keyboard ?? []) {
        for (const btn of row) texts.push(btn.text);
      }
    }

    expect(texts.length).toBeGreaterThan(10);
    assertNoForbiddenEnglish(texts);
  });
});
