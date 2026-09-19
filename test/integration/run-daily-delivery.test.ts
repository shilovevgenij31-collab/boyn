/**
 * `runDaily` -> automatic Telegram delivery wiring (Phase 8/9 production
 * hotfix, brief §24-27): the daily pipeline previously generated/froze a
 * DailyReport but never delivered it — this proves the fix end to end,
 * PGlite-backed, entirely offline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { runDaily } from "@/jobs/run-daily.ts";
import { buildTestTelegramContext, insertScoredPost, resetTelegramFixtureDb, REPORT_CHAT_ID } from "./helpers/telegram-fixtures.ts";
import { dailyReports } from "@/db/schema.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe("runDaily — automatic report delivery (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetTelegramFixtureDb(db);
  });

  it("generates the report AND delivers it to TELEGRAM_REPORT_CHAT_ID in one run", async () => {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
    const clock = new FixedClock(NOW);
    const ctx = buildTestTelegramContext(db, clock);

    const result = await runDaily({ db, clock, market: GLOBAL_MARKET, timezone: "UTC", telegramContext: ctx });

    expect(result.report.written).toBe(true);
    expect(result.delivery.attempted).toBe(true);
    expect(result.delivery.delivered).toBe(true);

    const mainMessage = ctx.client.sentMessages.find((m) => m.chat_id === REPORT_CHAT_ID);
    expect(mainMessage).toBeDefined();

    const [row] = await db.select({ deliveredAt: dailyReports.deliveredAt }).from(dailyReports).where(eq(dailyReports.reportDate, result.report.reportDate));
    expect(row?.deliveredAt).not.toBeNull();
  });

  it("does not resend an already-delivered report on a second run the same day", async () => {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
    const clock = new FixedClock(NOW);
    const ctx = buildTestTelegramContext(db, clock);

    const first = await runDaily({ db, clock, market: GLOBAL_MARKET, timezone: "UTC", telegramContext: ctx });
    expect(first.delivery.delivered).toBe(true);
    const sentAfterFirst = ctx.client.sentMessages.length;

    const second = await runDaily({ db, clock, market: GLOBAL_MARKET, timezone: "UTC", telegramContext: ctx });
    expect(second.delivery.attempted).toBe(true);
    expect(second.delivery.delivered).toBe(false);
    expect(second.delivery.alreadyDelivered).toBe(true);
    expect(ctx.client.sentMessages).toHaveLength(sentAfterFirst); // nothing new sent
  });

  it("skips delivery (without failing analytics/report generation) when Telegram isn't configured", async () => {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
    const clock = new FixedClock(NOW);

    const result = await runDaily({ db, clock, market: GLOBAL_MARKET, timezone: "UTC" }); // no telegramContext

    expect(result.report.written).toBe(true);
    expect(result.delivery.attempted).toBe(false);
  });

  it("still attempts delivery for a sparse report with no qualifying posts (an empty report is valid, not a failure)", async () => {
    const clock = new FixedClock(NOW);
    const ctx = buildTestTelegramContext(db, clock);
    const result = await runDaily({ db, clock, market: GLOBAL_MARKET, timezone: "UTC", telegramContext: ctx });
    expect(result.report.reportDate).not.toBe("");
    expect(result.delivery.attempted).toBe(true);
  });
});
