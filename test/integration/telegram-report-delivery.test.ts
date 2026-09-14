/**
 * Automatic DailyReport delivery idempotency (Phase 8 brief §86) —
 * PGlite-backed, recording client, entirely offline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { deliverDailyReport } from "@/telegram/deliver-report.ts";
import { buildTestTelegramContext, insertScoredPost, resetTelegramFixtureDb, seedDailyReport, REPORT_CHAT_ID } from "./helpers/telegram-fixtures.ts";
import { dailyReports } from "@/db/schema.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe("deliverDailyReport (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetTelegramFixtureDb(db);
  });

  async function seedReportWithStillHot(): Promise<string> {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "today1", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 90, views: 300_000 });
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "stillhot1", publishedAt: hoursAgo(30), tier: "VIRAL_QUALIFIED", trendScore: 60, views: 100_000 });
    return seedDailyReport(db, new FixedClock(NOW));
  }

  it("sends the main paginated message with canonical direct links, then marks delivered", async () => {
    const reportDate = await seedReportWithStillHot();
    const ctx = buildTestTelegramContext(db, new FixedClock(NOW));

    const result = await deliverDailyReport(ctx, reportDate);
    expect(result.delivered).toBe(true);

    const main = ctx.client.sentMessages.find((m) => m.chat_id === REPORT_CHAT_ID);
    expect(main).toBeDefined();
    const urlButtons = main!.reply_markup!.inline_keyboard[0]!;
    expect(urlButtons.length).toBeGreaterThan(0);
    for (const btn of urlButtons) {
      expect(btn.url).toMatch(/^https:\/\/www\.(tiktok|instagram)\.com\//);
    }

    const [row] = await db.select({ deliveredAt: dailyReports.deliveredAt }).from(dailyReports).where(eq(dailyReports.reportDate, reportDate));
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("a second delivery attempt is a no-op — does not resend", async () => {
    const reportDate = await seedReportWithStillHot();
    const ctx = buildTestTelegramContext(db, new FixedClock(NOW));

    const first = await deliverDailyReport(ctx, reportDate);
    expect(first.delivered).toBe(true);
    const countAfterFirst = ctx.client.sentMessages.length;

    const second = await deliverDailyReport(ctx, reportDate);
    expect(second.alreadyDelivered).toBe(true);
    expect(second.delivered).toBe(false);
    expect(ctx.client.sentMessages).toHaveLength(countAfterFirst); // nothing new sent
  });

  it("a failure partway through leaves delivered_at unset and resumes correctly, without resending the already-sent piece", async () => {
    const reportDate = await seedReportWithStillHot();
    const ctx = buildTestTelegramContext(db, new FixedClock(NOW));

    // Fail the SECOND sendMessage call (the Still Hot prompt) only.
    let calls = 0;
    const realSendMessage = ctx.client.sendMessage.bind(ctx.client);
    ctx.client.sendMessage = async (params) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated network failure");
      return realSendMessage(params);
    };

    await expect(deliverDailyReport(ctx, reportDate)).rejects.toThrow("simulated network failure");

    const [rowAfterFailure] = await db.select({ deliveredAt: dailyReports.deliveredAt, telegramMessageIds: dailyReports.telegramMessageIds }).from(dailyReports).where(eq(dailyReports.reportDate, reportDate));
    expect(rowAfterFailure!.deliveredAt).toBeNull(); // never marked delivered
    expect(rowAfterFailure!.telegramMessageIds).toEqual(expect.arrayContaining([expect.stringMatching(/^main:/)])); // the main piece DID get recorded

    // Restore a working client and retry — must not resend "main" again.
    ctx.client.sendMessage = realSendMessage;
    const sentBeforeRetry = ctx.client.sentMessages.length;
    const retryResult = await deliverDailyReport(ctx, reportDate);
    expect(retryResult.delivered).toBe(true);

    const mainMessagesSentTotal = ctx.client.sentMessages.filter((m) => m.reply_markup?.inline_keyboard[0]?.some((b) => b.url)).length;
    expect(mainMessagesSentTotal).toBe(1); // main was sent exactly once across both attempts
    expect(ctx.client.sentMessages.length).toBe(sentBeforeRetry + 1); // only the missing stillhot piece was sent on retry

    const [rowAfterRetry] = await db.select({ deliveredAt: dailyReports.deliveredAt }).from(dailyReports).where(eq(dailyReports.reportDate, reportDate));
    expect(rowAfterRetry!.deliveredAt).not.toBeNull();
  });

  it("skips delivery (without throwing) when TELEGRAM_REPORT_CHAT_ID is not configured", async () => {
    const reportDate = await seedReportWithStillHot();
    const ctx = buildTestTelegramContext(db, new FixedClock(NOW), { reportChatId: null });
    const result = await deliverDailyReport(ctx, reportDate);
    expect(result.delivered).toBe(false);
    expect(result.skippedReason).toMatch(/TELEGRAM_REPORT_CHAT_ID/);
    expect(ctx.client.sentMessages).toHaveLength(0);
  });

  it("returns a safe not-found result for a report date that doesn't exist", async () => {
    const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
    const result = await deliverDailyReport(ctx, "2020-01-01");
    expect(result.delivered).toBe(false);
    expect(result.alreadyDelivered).toBe(false);
  });
});
