/**
 * Admin-command and export integration tests (Phase 8 brief §81-84) —
 * PGlite-backed, recording client, no network/provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { ADMIN_ID, buildTestTelegramContext, insertScoredPost, resetTelegramFixtureDb, seedDailyReport, seedTrackedHashtag } from "./helpers/telegram-fixtures.ts";
import type { TelegramMessage } from "@/telegram/types.ts";
import { posts, hashtags, trackedHashtags, hashtagTierEvents, providerJobs, collectionRuns } from "@/db/schema.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { upsertHashtagDailyStat } from "@/db/repositories/analytics-hashtags.ts";
import { setCollectionPaused } from "@/db/repositories/settings.ts";
import { createCollectionRun } from "@/db/repositories/runs.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

function adminMessage(text: string): TelegramMessage {
  return { message_id: 1, from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" }, date: 0, text };
}

let updateIdCounter = 0;
function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

describe("Telegram admin commands (PGlite-backed)", () => {
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

  describe("/export", () => {
    it("with no report yet, says so instead of crashing", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/export") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/отчёт ещё не сформирован/i);
      expect(ctx.client.sentDocuments).toHaveLength(0);
    });

    it("sends exactly 3 documents (.md, .csv, .json) with correct filenames", async () => {
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
      const reportDate = await seedDailyReport(db, new FixedClock(NOW));

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/export") });

      expect(ctx.client.sentDocuments).toHaveLength(3);
      const filenames = ctx.client.sentDocuments.map((d) => d.filename).sort();
      expect(filenames).toEqual([`trends-${reportDate}.csv`, `trends-${reportDate}.json`, `trends-${reportDate}.md`].sort());
    });

    it("enforces a cooldown between exports", async () => {
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
      await seedDailyReport(db, new FixedClock(NOW));

      const clock = new FixedClock(NOW);
      const ctx = buildTestTelegramContext(db, clock);
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/export") });
      expect(ctx.client.sentDocuments).toHaveLength(3);

      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/export") });
      expect(ctx.client.sentDocuments).toHaveLength(3); // no new documents
      expect(ctx.client.sentMessages.some((m) => /повторный экспорт пока недоступен/i.test(m.text))).toBe(true);
    });

    it("/export 7d sends one CSV built from hashtag_daily_stats", async () => {
      const hashtagId = await upsertHashtag(db, "cosplay", NOW);
      await upsertHashtagDailyStat(db, {
        date: NOW.toISOString().slice(0, 10),
        platform: "tiktok",
        market: "global",
        hashtagId,
        postsSeen: 10,
        watchPosts: 2,
        viralPosts: 3,
        breakoutPosts: 1,
        distinctCreators: 5,
        viralViewsSum: 500_000,
        medianVph: 2000,
        scans: 4,
        trendState: "RISING",
        momentum: 0.42,
      });

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/export 7d") });
      expect(ctx.client.sentDocuments).toHaveLength(1);
      expect(ctx.client.sentDocuments[0]!.filename).toMatch(/^hashtags-7d-.*\.csv$/);
      const content = ctx.client.sentDocuments[0]!.content as string;
      expect(content).toContain("cosplay");
      expect(content).toContain("radar_momentum");
    });
  });

  describe("/refresh", () => {
    it("accepted: plans a durable MANUAL collection run + PENDING provider job, no direct provider call", async () => {
      await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/поставлен в очередь/i);

      const runs = await db.select().from(collectionRuns).where(eq(collectionRuns.kind, "MANUAL"));
      expect(runs).toHaveLength(1);
      const jobs = await db.select().from(providerJobs).where(eq(providerJobs.collectionRunId, runs[0]!.id));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe("PENDING");
    });

    it("nothing due: no tracked hashtags to scan", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/нет хэштегов, которые пора сканировать/i);
    });

    it("cooldown: a second /refresh for the same platform within 30 min is denied", async () => {
      await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
      const clock = new FixedClock(NOW);
      const ctx = buildTestTelegramContext(db, clock);
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/поставлен в очередь/i);

      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[1]!.text).toMatch(/повторный запуск пока недоступен/i);
    });

    it("budget exhausted: refuses once the monthly LEAN ceiling is hit", async () => {
      await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
      const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: `budget-${Math.random()}`, plannedAt: NOW });
      await db.insert(providerJobs).values({ collectionRunId: run.id, provider: "apify", platform: "tiktok", jobType: "HASHTAG_DISCOVERY", status: "READY", submittedAt: NOW, recordsReturned: 10, costEstUsd: "10.00" });

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/бюджет.*исчерпан/i);
    });

    it("collection_paused: refuses while paused", async () => {
      await seedTrackedHashtag(db, "cosplay", "tiktok", "CORE", NOW);
      await setCollectionPaused(db, true, NOW);
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh tiktok") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/на паузе/i);
    });

    it("provider circuit open with no fallback (Instagram): reports provider unavailable", async () => {
      await seedTrackedHashtag(db, "playstation", "instagram", "CORE", NOW);
      const circuitBreaker = new CircuitBreaker(new DbCircuitBreakerStore(db), new FixedClock(NOW));
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure({ provider: "apify", platform: "instagram", operation: "DISCOVERY" }, new Error("boom"));
      }
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh instagram") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/провайдер временно недоступен/i);
    });

    it("never says anything implying a direct Instagram post-URL refresh happened", async () => {
      await seedTrackedHashtag(db, "playstation", "instagram", "CORE", NOW);
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/refresh instagram") });
      expect(ctx.client.sentMessages[0]!.text).not.toMatch(/обновление постов instagram по ссылке/i);
    });
  });

  describe("/track", () => {
    it("normalizes #PS5 to ps5 and defaults to EXPLORATION", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #PS5") });
      expect(ctx.client.sentMessages[0]!.text).toContain("#ps5");
      expect(ctx.client.sentMessages[0]!.text).toContain("EXPLORATION");

      const [hashtag] = await db.select().from(hashtags).where(eq(hashtags.name, "ps5"));
      expect(hashtag).toBeDefined();
      const [tracked] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtag!.id));
      expect(tracked!.tier).toBe("EXPLORATION");
    });

    it("duplicate track reports already tracked, does not reset tier", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #dupe active") });
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #dupe exploration") });
      expect(ctx.client.sentMessages[1]!.text).toMatch(/уже отслеживается/i);

      const [hashtag] = await db.select().from(hashtags).where(eq(hashtags.name, "dupe"));
      const [tracked] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtag!.id));
      expect(tracked!.tier).toBe("ACTIVE"); // unchanged by the second call
    });

    it("supports manual ACTIVE and CORE tiers explicitly", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #activetag active") });
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #coretag core") });
      expect(ctx.client.sentMessages[0]!.text).toContain("ACTIVE");
      expect(ctx.client.sentMessages[1]!.text).toContain("CORE");
    });

    it("refuses a blocked hashtag", async () => {
      const hashtagId = await upsertHashtag(db, "blockedtag", NOW);
      await db.update(hashtags).set({ isBlocked: true }).where(eq(hashtags.id, hashtagId));

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #blockedtag") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/заблокирован/i);

      const tracked = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtagId));
      expect(tracked).toHaveLength(0);
    });

    it("writes a MANUAL_ADMIN tier_events audit row on a new track", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/track tiktok #audited") });
      const [hashtag] = await db.select().from(hashtags).where(eq(hashtags.name, "audited"));
      const [tracked] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtag!.id));
      const events = await db.select().from(hashtagTierEvents).where(eq(hashtagTierEvents.trackedHashtagId, tracked!.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.reason).toBe("MANUAL_ADMIN");
      expect(events[0]!.fromTier).toBeNull();
      expect(events[0]!.toTier).toBe("EXPLORATION");
    });
  });

  describe("/untrack", () => {
    it("moves an ACTIVE tag to DORMANT and writes an audit event, never deletes history", async () => {
      const { hashtagId, trackedId } = await seedTrackedHashtag(db, "willuntrack", "tiktok", "ACTIVE", NOW);
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/untrack tiktok #willuntrack") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/DORMANT/);

      const [tracked] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.id, trackedId));
      expect(tracked!.tier).toBe("DORMANT");
      const [hashtag] = await db.select().from(hashtags).where(eq(hashtags.id, hashtagId));
      expect(hashtag).toBeDefined(); // never deleted

      const events = await db.select().from(hashtagTierEvents).where(eq(hashtagTierEvents.trackedHashtagId, trackedId));
      expect(events.some((e) => e.reason === "MANUAL_ADMIN" && e.toTier === "DORMANT")).toBe(true);
    });

    it("a tag never tracked on that platform is reported safely", async () => {
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/untrack tiktok #neverheardofit") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/не отслеживается/i);
    });

    it("an already-DORMANT tag reports as such", async () => {
      await seedTrackedHashtag(db, "alreadydormant", "tiktok", "DORMANT", NOW);
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/untrack tiktok #alreadydormant") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/уже переведён в DORMANT/i);
    });
  });

  describe("/why", () => {
    it("shows structured score components and 'unavailable' (not 0) for a missing acceleration", async () => {
      const publishedAt = hoursAgo(2);
      await db.insert(posts).values({
        platform: "tiktok",
        externalId: "why-test-1",
        market: "global",
        canonicalUrl: "https://www.tiktok.com/@x/video/why-test-1",
        contentType: "video",
        creatorUsername: "creator",
        publishedAt,
        views: 100_000,
        likes: 5000,
        comments: 100,
        shares: 50,
        firstSeenAt: publishedAt,
        lastSeenAt: publishedAt,
        tier: "VIRAL_QUALIFIED",
        availability: "ACTIVE",
        vph: "2000.00",
        vphKind: "OBSERVED",
        velocityConfidence: "HIGH",
        trendScore: 88,
        risingScore: 60,
        trendState: "ACTIVE",
        scoreComponents: {
          trend: [
            { component: "velocity", available: true, raw: 2000, z: 1.1, normalized: 0.7, weightConfigured: 0.35, weightUsed: 0.35 },
            { component: "acceleration", available: false, raw: null, z: null, normalized: null, weightConfigured: 0.05, weightUsed: null },
          ],
          rising: [{ component: "velocity", available: true, raw: 2000, z: 1.1, normalized: 0.7, weightConfigured: 0.5, weightUsed: 0.5 }],
        },
        scoringVersion: 1,
      });
      await seedDailyReport(db, new FixedClock(NOW));

      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/why 1") });
      const text = ctx.client.sentMessages[0]!.text;
      expect(text).toMatch(/Скорость роста: \+2 тыс\.\/ч/); // OBSERVED kind: "+" prefix, no "оцен." suffix
      expect(text).not.toMatch(/оцен\./);
      expect(text).toContain("Ускорение: недоступно");
      expect(text).not.toMatch(/Ускорение:.*\bсырое значение 0\b/);
    });

    it("an out-of-range rank is reported safely", async () => {
      await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: hoursAgo(2), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
      await seedDailyReport(db, new FixedClock(NOW));
      const ctx = buildTestTelegramContext(db, new FixedClock(NOW));
      await routeUpdate(ctx, { update_id: nextUpdateId(), message: adminMessage("/why 999") });
      expect(ctx.client.sentMessages[0]!.text).toMatch(/не найден/i);
    });
  });
});
