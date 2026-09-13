/**
 * Hashtag-side analytics queries/persistence (Phase 6 brief §30-40).
 * Rolling stat queries here answer "how many qualified posts / distinct
 * creators / watch posts has this tag been SEEN on recently" — the raw
 * inputs core/analytics/trend-state.ts and core/lifecycle/hashtag-
 * lifecycle.ts turn into a state/decision. No trend/lifecycle logic here.
 */
import { and, asc, count, countDistinct, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { hashtagDailyStats, hashtagTierEvents, hashtags, postHashtags, posts, trackedHashtags } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { HashtagSource, TrackingTier, TrendState } from "@/core/domain/tracking.ts";

export interface TrackedHashtagForAnalytics {
  trackedHashtagId: number;
  hashtagId: number;
  hashtagName: string;
  platform: Platform;
  market: string;
  tier: TrackingTier;
  source: HashtagSource;
  trendState: TrendState;
  trendStateSince: Date | null;
  tierChangedAt: Date | null;
  probesInTier: number;
  consecutiveEmptyScans: number;
  momentum: string | null;
}

export async function getTrackedHashtagsForAnalytics(db: Database, market: string): Promise<TrackedHashtagForAnalytics[]> {
  return db
    .select({
      trackedHashtagId: trackedHashtags.id,
      hashtagId: trackedHashtags.hashtagId,
      hashtagName: hashtags.name,
      platform: trackedHashtags.platform,
      market: trackedHashtags.market,
      tier: trackedHashtags.tier,
      source: trackedHashtags.source,
      trendState: trackedHashtags.trendState,
      trendStateSince: trackedHashtags.trendStateSince,
      tierChangedAt: trackedHashtags.tierChangedAt,
      probesInTier: trackedHashtags.probesInTier,
      consecutiveEmptyScans: trackedHashtags.consecutiveEmptyScans,
      momentum: trackedHashtags.momentum,
    })
    .from(trackedHashtags)
    .innerJoin(hashtags, eq(hashtags.id, trackedHashtags.hashtagId))
    .where(eq(trackedHashtags.market, market));
}

export interface Rolling24hStats {
  v24: number;
  c24: number;
  w24: number;
}

export interface QualifiedStatsSince {
  qualified: number;
  distinctCreators: number;
  watch: number;
}

/** Qualified/watch posts carrying this hashtag SEEN (lastSeenAt) since a
 * given instant — counted once per post regardless of which query found
 * it (the join is on post_hashtags, not post_discoveries). Creator
 * identity falls back to externalId when a username isn't known, and to
 * a per-post synthetic key as a last resort so an unknown creator never
 * silently collapses distinct creators into one bucket. Shared by both
 * the 24h trend-state window (plan §17) and lifecycle's "since entering
 * this tier" evidence window (brief §37), which are genuinely different
 * windows over the same underlying signal. */
export async function getHashtagQualifiedStatsSince(db: Database, hashtagId: number, platform: Platform, market: string, since: Date): Promise<QualifiedStatsSince> {
  const rows = await db
    .select({
      postId: posts.id,
      tier: posts.tier,
      creatorKey: sql<string>`coalesce(${posts.creatorUsername}, ${posts.creatorExternalId}, ${posts.id}::text)`,
    })
    .from(postHashtags)
    .innerJoin(posts, eq(posts.id, postHashtags.postId))
    .where(and(eq(postHashtags.hashtagId, hashtagId), eq(posts.platform, platform), eq(posts.market, market), gte(posts.lastSeenAt, since)));

  const qualified = rows.filter((r) => r.tier === "VIRAL_QUALIFIED" || r.tier === "EARLY_BREAKOUT");
  const watch = rows.filter((r) => r.tier === "WATCH");
  return { qualified: qualified.length, distinctCreators: new Set(qualified.map((r) => r.creatorKey)).size, watch: watch.length };
}

/** v24/c24/w24 (plan §17): the last-24h view of getHashtagQualifiedStatsSince. */
export async function getHashtagRolling24hStats(db: Database, hashtagId: number, platform: Platform, market: string, now: Date): Promise<Rolling24hStats> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const stats = await getHashtagQualifiedStatsSince(db, hashtagId, platform, market, since);
  return { v24: stats.qualified, c24: stats.distinctCreators, w24: stats.watch };
}

/** The last `limit` days' hashtag_daily_stats trend_state, most-recent-
 * first — used by lifecycle to count consecutive weak (FALLING/DEAD)
 * evaluations (brief §38) without a dedicated running counter column. */
export async function getRecentDailyTrendStates(db: Database, hashtagId: number, platform: Platform, market: string, limit: number): Promise<TrendState[]> {
  const rows = await db
    .select({ trendState: hashtagDailyStats.trendState })
    .from(hashtagDailyStats)
    .where(and(eq(hashtagDailyStats.hashtagId, hashtagId), eq(hashtagDailyStats.platform, platform), eq(hashtagDailyStats.market, market)))
    .orderBy(desc(hashtagDailyStats.date))
    .limit(limit);
  return rows.map((r) => r.trendState).filter((s): s is TrendState => s !== null);
}

/** Qualified posts carrying this hashtag within `windowHours`, regardless
 * of tracking state — the "seen via any path" passive-revival signal
 * (plan §11) a DORMANT tag needs, since it isn't being actively scanned. */
export async function getQualifiedPostsAnyPath(db: Database, hashtagId: number, platform: Platform, market: string, now: Date, windowHours: number): Promise<number> {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const [row] = await db
    .select({ n: count() })
    .from(postHashtags)
    .innerJoin(posts, eq(posts.id, postHashtags.postId))
    .where(
      and(
        eq(postHashtags.hashtagId, hashtagId),
        eq(posts.platform, platform),
        eq(posts.market, market),
        gte(posts.lastSeenAt, since),
        inArray(posts.tier, ["VIRAL_QUALIFIED", "EARLY_BREAKOUT"]),
      ),
    );
  return row?.n ?? 0;
}

export interface TrailingHistory {
  /** Mean daily `viral_posts` over the 7 days before today. */
  b7: number;
  /** Days since this tag's first `hashtag_daily_stats` row — < 2 means
   * "NEW" per plan §17. */
  historyDays: number;
}

export async function getHashtagTrailingHistory(db: Database, hashtagId: number, platform: Platform, market: string, todayStart: Date): Promise<TrailingHistory> {
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 24 * 3_600_000);
  const rows = await db
    .select({ date: hashtagDailyStats.date, viralPosts: hashtagDailyStats.viralPosts })
    .from(hashtagDailyStats)
    .where(
      and(
        eq(hashtagDailyStats.hashtagId, hashtagId),
        eq(hashtagDailyStats.platform, platform),
        eq(hashtagDailyStats.market, market),
        gte(hashtagDailyStats.date, sevenDaysAgo.toISOString().slice(0, 10)),
        lt(hashtagDailyStats.date, todayStart.toISOString().slice(0, 10)),
      ),
    );

  const [firstRow] = await db
    .select({ date: hashtagDailyStats.date })
    .from(hashtagDailyStats)
    .where(and(eq(hashtagDailyStats.hashtagId, hashtagId), eq(hashtagDailyStats.platform, platform), eq(hashtagDailyStats.market, market)))
    .orderBy(asc(hashtagDailyStats.date))
    .limit(1);

  const b7 = rows.length > 0 ? rows.reduce((sum, r) => sum + r.viralPosts, 0) / rows.length : 0;
  const historyDays = firstRow ? Math.floor((todayStart.getTime() - new Date(firstRow.date).getTime()) / (24 * 3_600_000)) : 0;
  return { b7, historyDays };
}

export interface DailyStatUpsert {
  date: string; // YYYY-MM-DD
  platform: Platform;
  market: string;
  hashtagId: number;
  postsSeen: number;
  watchPosts: number;
  viralPosts: number;
  breakoutPosts: number;
  distinctCreators: number;
  viralViewsSum: number | null;
  medianVph: number | null;
  scans: number;
  trendState: TrendState | null;
  momentum: number | null;
}

/** Full replace (SET, not increment) so rerunning analytics for the same
 * day is idempotent — no double-counting (brief §4). */
export async function upsertHashtagDailyStat(db: Database, stat: DailyStatUpsert): Promise<void> {
  await db
    .insert(hashtagDailyStats)
    .values({
      date: stat.date,
      platform: stat.platform,
      market: stat.market,
      hashtagId: stat.hashtagId,
      postsSeen: stat.postsSeen,
      watchPosts: stat.watchPosts,
      viralPosts: stat.viralPosts,
      breakoutPosts: stat.breakoutPosts,
      distinctCreators: stat.distinctCreators,
      viralViewsSum: stat.viralViewsSum,
      medianVph: stat.medianVph !== null ? stat.medianVph.toFixed(2) : null,
      scans: stat.scans,
      trendState: stat.trendState,
      momentum: stat.momentum !== null ? stat.momentum.toFixed(5) : null,
    })
    .onConflictDoUpdate({
      target: [hashtagDailyStats.date, hashtagDailyStats.platform, hashtagDailyStats.market, hashtagDailyStats.hashtagId],
      set: {
        postsSeen: sql.raw('excluded."posts_seen"'),
        watchPosts: sql.raw('excluded."watch_posts"'),
        viralPosts: sql.raw('excluded."viral_posts"'),
        breakoutPosts: sql.raw('excluded."breakout_posts"'),
        distinctCreators: sql.raw('excluded."distinct_creators"'),
        viralViewsSum: sql.raw('excluded."viral_views_sum"'),
        medianVph: sql.raw('excluded."median_vph"'),
        scans: sql.raw('excluded."scans"'),
        trendState: sql.raw('excluded."trend_state"'),
        momentum: sql.raw('excluded."momentum"'),
      },
    });
}

export async function updateTrackedHashtagTrendState(db: Database, trackedHashtagId: number, params: { trendState: TrendState; trendStateSince: Date; momentum: number | null }): Promise<void> {
  await db
    .update(trackedHashtags)
    .set({ trendState: params.trendState, trendStateSince: params.trendStateSince, momentum: params.momentum !== null ? params.momentum.toFixed(5) : null })
    .where(eq(trackedHashtags.id, trackedHashtagId));
}

export interface TierEventParams {
  trackedHashtagId: number;
  fromTier: TrackingTier | null;
  toTier: TrackingTier;
  reason: string;
  at: Date;
}

/** Persists the transition AND advances tier_changed_at in one
 * transaction — a tier_events row is only ever written alongside an
 * actual tier change (brief §39: never on a no-op rerun). */
export async function applyTierTransition(db: Database, params: TierEventParams): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(hashtagTierEvents).values({
      trackedHashtagId: params.trackedHashtagId,
      fromTier: params.fromTier,
      toTier: params.toTier,
      reason: params.reason,
      at: params.at,
    });
    await tx
      .update(trackedHashtags)
      .set({ tier: params.toTier, tierChangedAt: params.at, probesInTier: 0, consecutiveEmptyScans: 0 })
      .where(eq(trackedHashtags.id, params.trackedHashtagId));
  });
}

export interface CandidateHashtag {
  hashtagId: number;
  name: string;
  qualifiedPosts: number;
  distinctCreators: number;
}

/** Untracked-tag candidate generation (plan §11 / brief §36): a
 * non-generic, non-blocked tag not already tracked for this (platform,
 * market) that appears on enough qualified posts by enough distinct
 * creators within the window. */
export async function getCandidateHashtags(
  db: Database,
  platform: Platform,
  market: string,
  now: Date,
  windowHours: number,
  minQualifiedPosts: number,
  minDistinctCreators: number,
): Promise<CandidateHashtag[]> {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const alreadyTracked = db
    .select({ hashtagId: trackedHashtags.hashtagId })
    .from(trackedHashtags)
    .where(and(eq(trackedHashtags.platform, platform), eq(trackedHashtags.market, market)));

  const rows = await db
    .select({
      hashtagId: hashtags.id,
      name: hashtags.name,
      qualifiedPosts: countDistinct(posts.id),
      distinctCreators: countDistinct(sql`coalesce(${posts.creatorUsername}, ${posts.creatorExternalId}, ${posts.id}::text)`),
    })
    .from(postHashtags)
    .innerJoin(hashtags, eq(hashtags.id, postHashtags.hashtagId))
    .innerJoin(posts, eq(posts.id, postHashtags.postId))
    .where(
      and(
        eq(posts.platform, platform),
        eq(posts.market, market),
        gte(posts.lastSeenAt, since),
        inArray(posts.tier, ["VIRAL_QUALIFIED", "EARLY_BREAKOUT"]),
        eq(hashtags.isGeneric, false),
        eq(hashtags.isBlocked, false),
        notInArray(hashtags.id, alreadyTracked),
      ),
    )
    .groupBy(hashtags.id, hashtags.name)
    .having(and(gte(countDistinct(posts.id), minQualifiedPosts), gte(countDistinct(sql`coalesce(${posts.creatorUsername}, ${posts.creatorExternalId}, ${posts.id}::text)`), minDistinctCreators)))
    .orderBy(desc(countDistinct(posts.id)));

  return rows;
}

/** How many tags newly entered `toTier` today (any reason) — the daily
 * new-EXPLORATION cap (plan §11: "≤3 new EXPLORATION tags/day") counts
 * across both candidate generation and passive revival together. */
export async function countTierEventsToday(db: Database, platform: Platform, market: string, toTier: TrackingTier, dayStart: Date, dayEnd: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hashtagTierEvents)
    .innerJoin(trackedHashtags, eq(trackedHashtags.id, hashtagTierEvents.trackedHashtagId))
    .where(
      and(
        eq(trackedHashtags.platform, platform),
        eq(trackedHashtags.market, market),
        eq(hashtagTierEvents.toTier, toTier),
        gte(hashtagTierEvents.at, dayStart),
        lt(hashtagTierEvents.at, dayEnd),
      ),
    );
  return row?.n ?? 0;
}
