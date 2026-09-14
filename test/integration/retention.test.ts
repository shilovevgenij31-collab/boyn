/**
 * Retention sweep integration tests (Phase 7 brief §62-64) — PGlite-
 * backed, exact TTL cutoffs per class, dry-run vs real-run, FK cascade
 * behavior, and confirmation that active tracking/audit state with no
 * explicit TTL is never touched.
 *
 * Boundary convention under test (see db/repositories/retention.ts): a
 * row exactly AT its TTL cutoff is kept (`age < cutoff`, strictly-less),
 * so retention is inclusive of the full N days and only strictly older
 * rows are swept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { runRetentionSweep } from "@/db/repositories/retention.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { applyTierTransition } from "@/db/repositories/analytics-hashtags.ts";
import { upsertScoringBaseline } from "@/db/repositories/analytics-baselines.ts";
import { computeRobustBaseline } from "@/core/analytics/baselines.ts";
import {
  appSettings,
  dailyReports,
  hashtagTierEvents,
  posts,
  postSnapshots,
  postHashtags,
  postDiscoveries,
  providerJobs,
  collectionRuns,
  scoringBaselines,
  trackedHashtags,
  hashtags,
} from "@/db/schema.ts";

async function resetAll(db: TestDatabase): Promise<void> {
  await db.delete(postDiscoveries);
  await db.delete(postSnapshots);
  await db.delete(postHashtags);
  await db.delete(dailyReports);
  await db.delete(posts);
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagTierEvents);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
  await db.delete(scoringBaselines);
  await db.delete(appSettings);
}

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DAY_MS = 24 * 3_600_000;

function daysAgo(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - extraMs);
}

let externalIdCounter = 0;
async function insertPost(db: TestDatabase, tier: "NOISE" | "WATCH" | "VIRAL_QUALIFIED" | null, publishedAt: Date): Promise<number> {
  externalIdCounter += 1;
  const externalId = `retention-${externalIdCounter}`;
  const rows = await db
    .insert(posts)
    .values({
      platform: "tiktok",
      externalId,
      market: "global",
      canonicalUrl: `https://www.tiktok.com/@x/video/${externalId}`,
      contentType: "video",
      publishedAt,
      firstSeenAt: publishedAt,
      lastSeenAt: publishedAt,
      tier,
      availability: "ACTIVE",
    })
    .returning({ id: posts.id });
  return rows[0]!.id;
}

describe("retention sweep (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    externalIdCounter = 0;
    await resetAll(db);
  });

  it("dry run reports counts without deleting anything", async () => {
    await insertPost(db, "NOISE", daysAgo(14, 60_000)); // 14d + 1min old -> past TTL
    const dry = await runRetentionSweep(db, NOW, true);
    expect(dry.postsDeleted).toBe(1);

    const rows = await db.select().from(posts);
    expect(rows).toHaveLength(1); // nothing actually deleted
  });

  it("NOISE posts (14d TTL): kept exactly at the cutoff, deleted just past it", async () => {
    const insideId = await insertPost(db, "NOISE", daysAgo(13));
    const atCutoffId = await insertPost(db, "NOISE", daysAgo(14));
    const pastCutoffId = await insertPost(db, "NOISE", daysAgo(14, 60_000));

    const result = await runRetentionSweep(db, NOW, false);
    expect(result.postsDeleted).toBe(1);

    const remaining = (await db.select({ id: posts.id }).from(posts)).map((r) => r.id);
    expect(remaining).toEqual(expect.arrayContaining([insideId, atCutoffId]));
    expect(remaining).not.toContain(pastCutoffId);
  });

  it("WATCH posts (30d TTL) and VIRAL_QUALIFIED posts (180d TTL) use their own independent cutoffs", async () => {
    const watchKept = await insertPost(db, "WATCH", daysAgo(29));
    const watchDeleted = await insertPost(db, "WATCH", daysAgo(30, 60_000));
    const viralKeptPast30d = await insertPost(db, "VIRAL_QUALIFIED", daysAgo(60)); // older than WATCH's TTL but well within its own
    const viralDeleted = await insertPost(db, "VIRAL_QUALIFIED", daysAgo(180, 60_000));

    await runRetentionSweep(db, NOW, false);
    const remaining = (await db.select({ id: posts.id }).from(posts)).map((r) => r.id);

    expect(remaining).toContain(watchKept);
    expect(remaining).not.toContain(watchDeleted);
    expect(remaining).toContain(viralKeptPast30d);
    expect(remaining).not.toContain(viralDeleted);
  });

  it("a null (unknown) tier uses the conservative 180d TTL, never deleted aggressively", async () => {
    const unknownRecent = await insertPost(db, null, daysAgo(30));
    const unknownOld = await insertPost(db, null, daysAgo(180, 60_000));

    await runRetentionSweep(db, NOW, false);
    const remaining = (await db.select({ id: posts.id }).from(posts)).map((r) => r.id);
    expect(remaining).toContain(unknownRecent);
    expect(remaining).not.toContain(unknownOld);
  });

  it("post_snapshots (90d TTL) expire independently of their parent post's own (longer) retention", async () => {
    const postId = await insertPost(db, "VIRAL_QUALIFIED", daysAgo(200)); // would itself be past 180d... use a still-kept post instead
    // Re-seed with a post inside its own 180d window so only the snapshot TTL is under test.
    await db.delete(posts).where(eq(posts.id, postId));
    const keptPostId = await insertPost(db, "VIRAL_QUALIFIED", daysAgo(10));

    await db.insert(postSnapshots).values([
      { postId: keptPostId, observedAt: daysAgo(89), source: "DISCOVERY" },
      { postId: keptPostId, observedAt: daysAgo(90, 60_000), source: "DISCOVERY" },
    ]);

    const result = await runRetentionSweep(db, NOW, false);
    expect(result.snapshotsDeleted).toBe(1);
    expect(result.postsDeleted).toBe(0);

    const remainingPosts = await db.select({ id: posts.id }).from(posts);
    expect(remainingPosts).toHaveLength(1); // the VIRAL_QUALIFIED post itself survives

    const remainingSnaps = await db.select().from(postSnapshots);
    expect(remainingSnaps).toHaveLength(1);
  });

  it("daily_reports (365d TTL) are pruned by generatedAt, independent of everything else", async () => {
    await db.insert(dailyReports).values([
      { reportDate: "2026-01-01", market: "global", windowStart: daysAgo(365, 60_000), windowEnd: daysAgo(365, 60_000), status: "COMPLETE", payload: { schemaVersion: 1 }, generatedAt: daysAgo(365, 60_000) },
      { reportDate: "2026-08-01", market: "global", windowStart: daysAgo(40), windowEnd: daysAgo(40), status: "COMPLETE", payload: { schemaVersion: 1 }, generatedAt: daysAgo(40) },
    ]);

    const result = await runRetentionSweep(db, NOW, false);
    expect(result.dailyReportsDeleted).toBe(1);

    const remaining = await db.select({ reportDate: dailyReports.reportDate }).from(dailyReports);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.reportDate).toBe("2026-08-01");
  });

  it("cascade: deleting an expired post also removes its snapshots/hashtags/discoveries, but leaves an unrelated retained daily_report's frozen JSON untouched", async () => {
    const expiredPostId = await insertPost(db, "NOISE", daysAgo(20)); // past NOISE's 14d TTL
    await db.insert(postSnapshots).values({ postId: expiredPostId, observedAt: daysAgo(20), source: "DISCOVERY" });
    const hashtagId = await upsertHashtag(db, "willcascade", daysAgo(20));
    await db.insert(postHashtags).values({ postId: expiredPostId, hashtagId });

    await db.insert(dailyReports).values({
      reportDate: "2026-09-01",
      market: "global",
      windowStart: daysAgo(11),
      windowEnd: daysAgo(11),
      status: "COMPLETE",
      payload: { schemaVersion: 1, marker: "untouched-payload" },
      generatedAt: daysAgo(11), // well within the 365d TTL
    });

    await runRetentionSweep(db, NOW, false);

    expect(await db.select().from(posts)).toHaveLength(0);
    expect(await db.select().from(postSnapshots)).toHaveLength(0);
    expect(await db.select().from(postHashtags)).toHaveLength(0);

    const [report] = await db.select({ payload: dailyReports.payload }).from(dailyReports);
    expect(report?.payload).toEqual({ schemaVersion: 1, marker: "untouched-payload" });
  });

  it("never deletes active tracking/audit state that has no explicit TTL, regardless of age", async () => {
    const hashtagId = await upsertHashtag(db, "ancienttag", daysAgo(900));
    const tracked = await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "CORE", source: "SEED" });
    await applyTierTransition(db, { trackedHashtagId: tracked.id, fromTier: null, toTier: "CORE", reason: "seed", at: daysAgo(900) });
    await upsertScoringBaseline(db, { platform: "tiktok", market: "global", metric: "views", computedAt: daysAgo(900), baseline: computeRobustBaseline([1, 2, 3]) });
    await db.insert(appSettings).values({ key: "collection_paused", value: false, updatedAt: daysAgo(900) });

    await runRetentionSweep(db, NOW, false);

    expect(await db.select().from(trackedHashtags)).toHaveLength(1);
    expect(await db.select().from(hashtagTierEvents)).toHaveLength(1);
    expect(await db.select().from(scoringBaselines)).toHaveLength(1);
    expect(await db.select().from(appSettings)).toHaveLength(1);
  });
});
