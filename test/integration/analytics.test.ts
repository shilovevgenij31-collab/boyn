/**
 * Phase 6 analytics integration tests (brief §64-66) — PGlite-backed,
 * exercising runAnalytics() against real repository persistence: score
 * fields, baseline upserts, daily stats, co-occurrence, category dedupe,
 * tier-transition events, rerun idempotency, and refresh-priority
 * updates, plus a genuine EXPLORATION -> ACTIVE promotion and a
 * DORMANT/EXPLORATION demotion driven by real evidence (not hard-coded).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { runAnalytics } from "@/jobs/run-analytics.ts";
import { persistNormalizedObservation } from "@/db/repositories/posts.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { upsertScoringBaseline } from "@/db/repositories/analytics-baselines.ts";
import { computeRobustBaseline } from "@/core/analytics/baselines.ts";
import type { NormalizedPost } from "@/core/domain/social-post.ts";
import {
  collectionRuns,
  hashtagCategories,
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
  scoringBaselines,
  trackedHashtags,
} from "@/db/schema.ts";

async function resetDb(db: TestDatabase): Promise<void> {
  await db.delete(postDiscoveries);
  await db.delete(postSnapshots);
  await db.delete(postHashtags);
  await db.delete(postCategories);
  await db.delete(quarantinedItems);
  await db.delete(posts);
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagCategories);
  await db.delete(hashtagCooccurrenceDaily);
  await db.delete(hashtagDailyStats);
  await db.delete(hashtagTierEvents);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
  await db.delete(scoringBaselines);
}

let externalIdCounter = 0;
function nextExternalId(): string {
  externalIdCounter += 1;
  return `analytics-test-${externalIdCounter}`;
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

/** Persists a post with two snapshots (observedAt2 > observedAt1, views2
 * > views1) so velocity.ts sees a real OBSERVED interval — a single
 * persistNormalizedObservation call only ever creates one snapshot. */
async function seedPostWithVelocity(
  db: TestDatabase,
  params: {
    publishedAt: Date;
    firstSeenAt: Date;
    firstViews: number;
    secondSeenAt: Date;
    secondViews: number;
    hashtagNames?: string[];
    likes?: number;
    comments?: number;
    shares?: number;
    platform?: "tiktok" | "instagram";
  },
): Promise<number> {
  const externalId = nextExternalId();
  const base = makeNormalizedPost({
    externalId,
    platform: params.platform ?? "tiktok",
    publishedAt: params.publishedAt,
    hashtags: params.hashtagNames ?? [],
    metrics: { views: params.firstViews, viewsMetric: "tt_apify_play_count", likes: params.likes ?? 100, comments: params.comments ?? 10, shares: params.shares ?? 5, saves: null },
    observedAt: params.firstSeenAt,
  });
  const first = await persistNormalizedObservation(db, { post: base, snapshotSource: "DISCOVERY" });

  const second = makeNormalizedPost({
    externalId,
    platform: params.platform ?? "tiktok",
    publishedAt: params.publishedAt,
    hashtags: params.hashtagNames ?? [],
    metrics: { views: params.secondViews, viewsMetric: "tt_apify_play_count", likes: params.likes ?? 100, comments: params.comments ?? 10, shares: params.shares ?? 5, saves: null },
    observedAt: params.secondSeenAt,
  });
  await persistNormalizedObservation(db, { post: second, snapshotSource: "DISCOVERY" });

  return first.postId;
}

describe("Phase 6 analytics", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetDb(db);
  });

  it("scores an eligible post: vph/tier/trendState/scoreComponents are persisted", async () => {
    const clock = new FixedClock(new Date("2026-09-12T06:00:00.000Z"));
    const postId = await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-12T02:00:00.000Z"),
      firstSeenAt: new Date("2026-09-12T03:00:00.000Z"),
      firstViews: 5_000,
      secondSeenAt: new Date("2026-09-12T05:00:00.000Z"),
      secondViews: 25_000,
    });

    const stats = await runAnalytics({ db, clock, market: "global" });
    expect(stats.postsAnalyzed).toBeGreaterThan(0);
    expect(stats.postsScored).toBeGreaterThan(0);

    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(row?.vph).not.toBeNull();
    expect(row?.vphKind).toBe("OBSERVED");
    expect(row?.tier).not.toBeNull();
    expect(row?.trendState).not.toBeNull();
    expect(row?.scoreComponents).not.toBeNull();
    expect(row?.scoringVersion).toBe(1);
  });

  it("baseline upsert is idempotent — calling it twice keeps exactly one row per (platform, market, metric)", async () => {
    const baseline = computeRobustBaseline([1000, 2000, 3000]);
    await upsertScoringBaseline(db, { platform: "tiktok", market: "global", metric: "views", computedAt: new Date(), baseline });
    await upsertScoringBaseline(db, { platform: "tiktok", market: "global", metric: "views", computedAt: new Date(), baseline: computeRobustBaseline([9000]) });

    const rows = await db.select().from(scoringBaselines).where(eq(scoringBaselines.metric, "views"));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.n)).toBe(1); // reflects the SECOND call's baseline, not a duplicate row
  });

  it("category dedupe: rerunning analytics never creates a duplicate hashtag_categories row", async () => {
    const clock = new FixedClock(new Date("2026-09-12T06:00:00.000Z"));
    await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-12T02:00:00.000Z"),
      firstSeenAt: new Date("2026-09-12T03:00:00.000Z"),
      firstViews: 5_000,
      secondSeenAt: new Date("2026-09-12T05:00:00.000Z"),
      secondViews: 20_000,
      hashtagNames: ["cosplay"],
    });

    await runAnalytics({ db, clock, market: "global" });
    const first = await db.select().from(hashtagCategories);
    await runAnalytics({ db, clock, market: "global" });
    const second = await db.select().from(hashtagCategories);

    expect(second.length).toBe(first.length);
    expect(first.some((r) => r.category === "cosplay")).toBe(true);
  });

  it("analytics rerun is idempotent: identical post/hashtag/daily-stat state after a second run at the same instant", async () => {
    const clock = new FixedClock(new Date("2026-09-12T06:00:00.000Z"));
    await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-12T02:00:00.000Z"),
      firstSeenAt: new Date("2026-09-12T03:00:00.000Z"),
      firstViews: 5_000,
      secondSeenAt: new Date("2026-09-12T05:00:00.000Z"),
      secondViews: 20_000,
      hashtagNames: ["cosplay"],
    });

    await runAnalytics({ db, clock, market: "global" });
    const postsAfterFirst = await db.select().from(posts);
    const dailyAfterFirst = await db.select().from(hashtagDailyStats);

    await runAnalytics({ db, clock, market: "global" });
    const postsAfterSecond = await db.select().from(posts);
    const dailyAfterSecond = await db.select().from(hashtagDailyStats);

    expect(postsAfterSecond).toHaveLength(postsAfterFirst.length);
    expect(dailyAfterSecond).toHaveLength(dailyAfterFirst.length);
    expect(postsAfterSecond[0]?.trendScore).toBe(postsAfterFirst[0]?.trendScore);
    expect(dailyAfterSecond[0]?.postsSeen).toBe(dailyAfterFirst[0]?.postsSeen);
  });

  it("refresh planning: a BREAKOUT-trending TikTok post gets its next refresh bumped sooner", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    const postId = await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-12T03:00:00.000Z"), // 2h old
      firstSeenAt: new Date("2026-09-12T03:48:00.000Z"),
      firstViews: 8_000,
      secondSeenAt: new Date("2026-09-12T04:36:00.000Z"),
      secondViews: 20_000, // fast growth, young post
      likes: 2000,
      comments: 100,
      shares: 150,
    });

    await runAnalytics({ db, clock, market: "global" });
    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(row?.trendState).toBe("BREAKOUT");
    expect(row?.nextRefreshAt).not.toBeNull();
    expect(row!.nextRefreshAt!.getTime()).toBeLessThanOrEqual(clock.now().getTime() + 3 * 3_600_000);
  });

  it("refresh planning: a DEAD old post has its next refresh cleared", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    const postId = await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-08T00:00:00.000Z"), // ~101h old
      firstSeenAt: new Date("2026-09-11T22:00:00.000Z"),
      firstViews: 2_000_000,
      secondSeenAt: new Date("2026-09-12T00:00:00.000Z"),
      secondViews: 2_000_010, // flat
    });

    await runAnalytics({ db, clock, market: "global" });
    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(row?.trendState).toBe("DEAD");
    expect(row?.nextRefreshAt).toBeNull();
  });

  it("EXPLORATION -> ACTIVE promotion happens from real evidence (>=2 qualified posts, >=2 distinct creators), with exactly one tier_events row", async () => {
    const clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    const hashtagId = await upsertHashtag(db, "gamingcosplaytest", clock.now());
    const tracked = await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "EXPLORATION", source: "DISCOVERED" });
    // Backdate tier_changed_at past the hysteresis window.
    await db.update(trackedHashtags).set({ tierChangedAt: new Date("2026-09-01T00:00:00.000Z") }).where(eq(trackedHashtags.id, tracked.id));

    // Two VIRAL_QUALIFIED posts (views >= 100k, age <= 72h) from two distinct creators, both tagged.
    for (const [creator, ext] of [["creatorA", "explo-promo-1"], ["creatorB", "explo-promo-2"]] as const) {
      const post = makeNormalizedPost({
        externalId: ext,
        publishedAt: new Date("2026-09-12T00:00:00.000Z"),
        observedAt: new Date("2026-09-12T06:00:00.000Z"),
        creator: { username: creator, externalId: creator, followers: 500, verified: false },
        hashtags: ["gamingcosplaytest"],
        metrics: { views: 150_000, viewsMetric: "tt_apify_play_count", likes: 5000, comments: 200, shares: 300, saves: null },
      });
      await persistNormalizedObservation(db, { post, snapshotSource: "DISCOVERY" });
    }

    const stats = await runAnalytics({ db, clock, market: "global" });
    expect(stats.tierPromotions).toBeGreaterThan(0);

    const [updated] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.id, tracked.id));
    expect(updated?.tier).toBe("ACTIVE");

    const events = await db.select().from(hashtagTierEvents).where(eq(hashtagTierEvents.trackedHashtagId, tracked.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.fromTier).toBe("EXPLORATION");
    expect(events[0]?.toTier).toBe("ACTIVE");
  });

  it("EXPLORATION -> DORMANT demotion happens after the probe/day budget is exhausted with no qualifying evidence", async () => {
    const clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    const hashtagId = await upsertHashtag(db, "deadexplorationtag", clock.now());
    const tracked = await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "EXPLORATION", source: "DISCOVERED" });
    await db
      .update(trackedHashtags)
      .set({ tierChangedAt: new Date("2026-09-01T00:00:00.000Z"), probesInTier: 2 })
      .where(eq(trackedHashtags.id, tracked.id));

    // No qualifying posts at all for this tag -> no promotion evidence.
    const stats = await runAnalytics({ db, clock, market: "global" });
    expect(stats.tierDemotions).toBeGreaterThan(0);

    const [updated] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.id, tracked.id));
    expect(updated?.tier).toBe("DORMANT");

    const events = await db.select().from(hashtagTierEvents).where(eq(hashtagTierEvents.trackedHashtagId, tracked.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.toTier).toBe("DORMANT");
  });

  it("co-occurrence is aggregated for posts with multiple meaningful hashtags", async () => {
    const clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    await seedPostWithVelocity(db, {
      publishedAt: new Date("2026-09-12T08:00:00.000Z"),
      firstSeenAt: new Date("2026-09-12T09:00:00.000Z"),
      firstViews: 10_000,
      secondSeenAt: new Date("2026-09-12T11:00:00.000Z"),
      secondViews: 30_000,
      hashtagNames: ["cosplay", "gaming"],
    });

    const stats = await runAnalytics({ db, clock, market: "global" });
    expect(stats.cooccurrencesUpdated).toBeGreaterThan(0);

    const rows = await db.select().from(hashtagCooccurrenceDaily);
    expect(rows.length).toBeGreaterThan(0);
  });
});
