/**
 * Phase 7 report-pipeline integration tests (brief §56, §60, §65) —
 * PGlite-backed, exercising jobs/generate-daily-report.ts (and, for the
 * end-to-end test, jobs/run-analytics.ts too) against real repository
 * persistence. Entirely offline: no provider API calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { generateDailyReport } from "@/jobs/generate-daily-report.ts";
import { runAnalytics } from "@/jobs/run-analytics.ts";
import { getDailyReport } from "@/db/repositories/reports.ts";
import { persistNormalizedObservation } from "@/db/repositories/posts.ts";
import { createCollectionRun } from "@/db/repositories/runs.ts";
import { exportCsv } from "@/core/report/export-csv.ts";
import { exportJson } from "@/core/report/export-json.ts";
import { exportMarkdown } from "@/core/report/export-markdown.ts";
import type { NormalizedPost } from "@/core/domain/social-post.ts";
import {
  collectionRuns,
  dailyReports,
  hashtagCooccurrenceDaily,
  hashtagDailyStats,
  hashtagTierEvents,
  hashtags,
  postCategories,
  postDiscoveries,
  postHashtags,
  postSnapshots,
  posts,
  providerJobs,
  quarantinedItems,
  trackedHashtags,
} from "@/db/schema.ts";

async function resetDb(db: TestDatabase): Promise<void> {
  await db.delete(postDiscoveries);
  await db.delete(postSnapshots);
  await db.delete(postHashtags);
  await db.delete(postCategories);
  await db.delete(quarantinedItems);
  await db.delete(dailyReports);
  await db.delete(posts);
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagCooccurrenceDaily);
  await db.delete(hashtagDailyStats);
  await db.delete(hashtagTierEvents);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
}

const NOW = new Date("2026-09-12T18:00:00.000Z");

let externalIdCounter = 0;
function nextExternalId(): string {
  externalIdCounter += 1;
  return `report-test-${externalIdCounter}`;
}

/** Directly inserts an already-scored post — these tests exercise report
 * generation, not analytics scoring (analytics.test.ts already covers
 * that), so posts here carry pre-set tier/trendState/trendScore fields. */
async function insertScoredPost(
  db: TestDatabase,
  params: { platform: "tiktok" | "instagram"; creatorUsername: string; publishedAt: Date; tier: "VIRAL_QUALIFIED" | "EARLY_BREAKOUT"; trendScore: number; views: number },
): Promise<number> {
  const externalId = nextExternalId();
  const rows = await db
    .insert(posts)
    .values({
      platform: params.platform,
      externalId,
      market: "global",
      canonicalUrl: `https://www.${params.platform === "tiktok" ? "tiktok.com/@x/video" : "instagram.com/p"}/${externalId}`,
      contentType: "video",
      creatorUsername: params.creatorUsername,
      caption: "a test post",
      publishedAt: params.publishedAt,
      views: params.views,
      likes: Math.round(params.views * 0.05),
      comments: 50,
      shares: 20,
      firstSeenAt: params.publishedAt,
      lastSeenAt: NOW,
      tier: params.tier,
      availability: "ACTIVE",
      vph: "1000.00",
      vphKind: "OBSERVED",
      velocityConfidence: "HIGH",
      trendScore: params.trendScore,
      risingScore: params.trendScore,
      trendState: "ACTIVE",
      scoreComponents: { trend: [], rising: [] },
      scoringVersion: 1,
    })
    .returning({ id: posts.id });
  return rows[0]!.id;
}

async function insertProviderJob(db: TestDatabase, collectionRunId: number, platform: "tiktok" | "instagram", status: "FAILED" | "READY" | "INGESTED"): Promise<void> {
  await db.insert(providerJobs).values({
    collectionRunId,
    provider: platform === "tiktok" ? "brightdata" : "apify",
    platform,
    jobType: "HASHTAG_DISCOVERY",
    status,
    recordsReturned: status === "FAILED" ? 0 : 5,
  });
}

function makeNormalizedPost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  const externalId = overrides.externalId ?? nextExternalId();
  return {
    platform: "tiktok",
    externalId,
    canonicalUrl: `https://www.tiktok.com/@creator/video/${externalId}`,
    contentType: "video",
    creator: { username: "creator1", externalId: "c1", followers: 1000, verified: false },
    caption: null,
    hashtags: [],
    music: null,
    publishedAt: new Date("2026-09-12T00:00:00.000Z"),
    durationSec: 20,
    metrics: { views: 1000, viewsMetric: "tt_apify_play_count", likes: 50, comments: 5, shares: 2, saves: null },
    observedAt: new Date("2026-09-12T00:00:00.000Z"),
    source: { provider: "apify", discoveryMethod: "search" },
    ...overrides,
  };
}

describe("Phase 7 daily report generation (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    externalIdCounter = 0;
    await resetDb(db);
  });

  it("mandatory scenario (brief §56): TikTok collection fails, Instagram succeeds -> PARTIAL, Instagram data present, no TikTok padding", async () => {
    const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: `slot-${Math.random()}`, plannedAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    await insertProviderJob(db, run.id, "tiktok", "FAILED");
    await insertProviderJob(db, run.id, "instagram", "READY");

    await insertScoredPost(db, { platform: "instagram", creatorUsername: "igcreator1", publishedAt: new Date(NOW.getTime() - 3 * 3_600_000), tier: "VIRAL_QUALIFIED", trendScore: 80, views: 100_000 });
    await insertScoredPost(db, { platform: "instagram", creatorUsername: "igcreator2", publishedAt: new Date(NOW.getTime() - 4 * 3_600_000), tier: "VIRAL_QUALIFIED", trendScore: 70, views: 90_000 });

    const clock = new FixedClock(NOW);
    const result = await generateDailyReport({ db, clock, market: "global", timezone: "UTC" });

    expect(result.status).toBe("PARTIAL");
    expect(result.partialReasons).toContain("tiktok:discovery_failed");

    const report = await getDailyReport(db, result.reportDate, "global");
    expect(report).not.toBeNull();
    expect(report!.todayTop.length).toBe(2);
    expect(report!.todayTop.every((i) => i.platform === "instagram")).toBe(true);
  });

  it("idempotency at the repository level (brief §60): generating twice with the same clock/state leaves exactly one daily_reports row with the same payload", async () => {
    await insertScoredPost(db, { platform: "tiktok", creatorUsername: "a", publishedAt: new Date(NOW.getTime() - 2 * 3_600_000), tier: "VIRAL_QUALIFIED", trendScore: 60, views: 50_000 });

    const clock = new FixedClock(NOW);
    const first = await generateDailyReport({ db, clock, market: "global", timezone: "UTC" });
    const second = await generateDailyReport({ db, clock, market: "global", timezone: "UTC" });

    expect(first.written).toBe(true);
    expect(second.written).toBe(true);

    const rows = await db.select().from(dailyReports).where(and(eq(dailyReports.reportDate, first.reportDate), eq(dailyReports.market, "global")));
    expect(rows).toHaveLength(1);

    const firstReport = await getDailyReport(db, first.reportDate, "global");
    const secondReport = await getDailyReport(db, second.reportDate, "global");
    expect(JSON.stringify(firstReport)).toBe(JSON.stringify(secondReport));
  });

  it("end-to-end offline pipeline (brief §65): runAnalytics -> generateDailyReport -> exports, entirely from PGlite, no network calls", async () => {
    const clock = new FixedClock(NOW);

    // Two snapshots each so velocity has a real OBSERVED interval.
    for (const [ext, creator, firstViews, secondViews] of [
      ["e2e-1", "creatorA", 5_000, 150_000],
      ["e2e-2", "creatorB", 3_000, 40_000],
    ] as const) {
      const first = makeNormalizedPost({
        externalId: ext,
        creator: { username: creator, externalId: creator, followers: 1000, verified: false },
        publishedAt: new Date(NOW.getTime() - 4 * 3_600_000),
        observedAt: new Date(NOW.getTime() - 3 * 3_600_000),
        hashtags: ["cosplay"],
        metrics: { views: firstViews, viewsMetric: "tt_apify_play_count", likes: 200, comments: 20, shares: 10, saves: null },
      });
      await persistNormalizedObservation(db, { post: first, snapshotSource: "DISCOVERY" });
      const second = makeNormalizedPost({
        externalId: ext,
        creator: { username: creator, externalId: creator, followers: 1000, verified: false },
        publishedAt: new Date(NOW.getTime() - 4 * 3_600_000),
        observedAt: new Date(NOW.getTime() - 1 * 3_600_000),
        hashtags: ["cosplay"],
        metrics: { views: secondViews, viewsMetric: "tt_apify_play_count", likes: 2000, comments: 200, shares: 100, saves: null },
      });
      await persistNormalizedObservation(db, { post: second, snapshotSource: "DISCOVERY" });
    }

    const analyticsStats = await runAnalytics({ db, clock, market: "global" });
    expect(analyticsStats.postsScored).toBeGreaterThan(0);

    const result = await generateDailyReport({ db, clock, market: "global", timezone: "UTC" });
    const report = await getDailyReport(db, result.reportDate, "global");
    expect(report).not.toBeNull();

    const json = exportJson(report!);
    expect(() => JSON.parse(json)).not.toThrow();

    const csv = exportCsv(report!);
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const md = exportMarkdown(report!);
    expect(md).toMatch(/tiktok\.com/);
    expect(md).not.toMatch(/apify\.com|brightdata\.com/);
  });
});
