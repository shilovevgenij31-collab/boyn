/**
 * Bounded, N+1-avoiding queries that feed `buildDailyReport` (Phase 7
 * brief §6, §51-52). No ranking/window-membership logic here — that's
 * core/report/build-daily-report.ts's job; this module only fetches
 * already-persisted Phase 6 analytics within explicit bounded windows
 * (never the whole lifetime posts table) and reshapes rows into the
 * plain-data input shapes `core/report/*` expects.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import {
  collectionRuns,
  hashtagCooccurrenceDaily,
  hashtagDailyStats,
  hashtagTierEvents,
  hashtags,
  postCategories,
  postHashtags,
  posts,
  postSnapshots,
  providerJobs,
  trackedHashtags,
} from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";
import { isCategory } from "@/core/domain/category.ts";
import type { VelocityKind } from "@/core/analytics/velocity.ts";
import type { ComponentDetail } from "@/core/analytics/scoring.ts";
import { HASHTAG_SECTION_MAX } from "@/config/report.ts";
import type { CandidatePost } from "@/core/report/build-daily-report.ts";
import type { TagItem, CollectionSummary } from "@/core/report/types.ts";
import type { ClusterEdge } from "@/core/report/build-clusters.ts";
import { getProviderUsageSince } from "./runs.ts";

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * Every post published within `horizonHours` (typically 72h — the Still
 * Hot outer bound), regardless of tier — `isRankable`/window-membership
 * filtering happens in the pure report layer, not here, so distribution/
 * counts over the full Today pool (including WATCH-tier posts) stay
 * correct.
 */
export async function getReportCandidatePosts(db: Database, market: string, now: Date, horizonHours: number): Promise<CandidatePost[]> {
  const since = new Date(now.getTime() - horizonHours * 3_600_000);
  const rows = await db
    .select({
      id: posts.id,
      platform: posts.platform,
      externalId: posts.externalId,
      canonicalUrl: posts.canonicalUrl,
      creatorUsername: posts.creatorUsername,
      caption: posts.caption,
      publishedAt: posts.publishedAt,
      views: posts.views,
      likes: posts.likes,
      comments: posts.comments,
      shares: posts.shares,
      vph: posts.vph,
      vphKind: posts.vphKind,
      velocityConfidence: posts.velocityConfidence,
      trendScore: posts.trendScore,
      risingScore: posts.risingScore,
      trendState: posts.trendState,
      tier: posts.tier,
      scoreComponents: posts.scoreComponents,
      availability: posts.availability,
      contentType: posts.contentType,
    })
    .from(posts)
    .where(and(eq(posts.market, market), gte(posts.publishedAt, since)));

  const postIds = rows.map((r) => r.id);
  const hashtagRows =
    postIds.length > 0
      ? await db
          .select({ postId: postHashtags.postId, name: hashtags.name })
          .from(postHashtags)
          .innerJoin(hashtags, eq(hashtags.id, postHashtags.hashtagId))
          .where(inArray(postHashtags.postId, postIds))
      : [];
  const categoryRows = postIds.length > 0 ? await db.select({ postId: postCategories.postId, category: postCategories.category }).from(postCategories).where(inArray(postCategories.postId, postIds)) : [];

  const hashtagsByPost = groupBy(hashtagRows, (r) => r.postId);
  const categoriesByPost = groupBy(categoryRows, (r) => r.postId);

  return rows
    .filter((r): r is typeof r & { publishedAt: Date } => r.publishedAt !== null)
    .map((r) => ({
      postId: r.id,
      platform: r.platform,
      externalId: r.externalId,
      canonicalUrl: r.canonicalUrl,
      creatorUsername: r.creatorUsername,
      caption: r.caption,
      hashtags: (hashtagsByPost.get(r.id) ?? []).map((h) => h.name),
      categories: (categoriesByPost.get(r.id) ?? []).map((c) => c.category).filter((c): c is Category => isCategory(c)),
      publishedAt: r.publishedAt,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      vph: r.vph !== null ? Number(r.vph) : null,
      vphKind: (r.vphKind ?? "NONE") as VelocityKind,
      velocityConfidence: r.velocityConfidence,
      trendScore: r.trendScore,
      risingScore: r.risingScore,
      trendState: r.trendState,
      tier: r.tier,
      scoreComponents: r.scoreComponents as { trend: ComponentDetail[]; rising: ComponentDetail[] } | null,
      availability: r.availability,
      contentType: r.contentType,
    }));
}

/** Co-occurrence edges for one calendar date, merged across platforms
 * (Phase 7 brief §30-31 asks for a small report-level projection, not a
 * platform-scoped one) — the same pair seen on both TikTok and Instagram
 * that day is summed into one edge. */
export async function getClusterEdges(db: Database, market: string, dateStr: string): Promise<ClusterEdge[]> {
  const rows = await db
    .select({ tagA: hashtagCooccurrenceDaily.tagA, tagB: hashtagCooccurrenceDaily.tagB, posts: hashtagCooccurrenceDaily.posts, viralPosts: hashtagCooccurrenceDaily.viralPosts, viewsSum: hashtagCooccurrenceDaily.viewsSum })
    .from(hashtagCooccurrenceDaily)
    .where(and(eq(hashtagCooccurrenceDaily.market, market), eq(hashtagCooccurrenceDaily.date, dateStr)));
  if (rows.length === 0) return [];

  const merged = new Map<string, { tagA: number; tagB: number; posts: number; viralPosts: number; viewsSum: number | null }>();
  for (const r of rows) {
    const key = `${r.tagA}:${r.tagB}`;
    const existing = merged.get(key);
    if (existing) {
      existing.posts += r.posts;
      existing.viralPosts += r.viralPosts;
      existing.viewsSum = existing.viewsSum === null && r.viewsSum === null ? null : (existing.viewsSum ?? 0) + (r.viewsSum ?? 0);
    } else {
      merged.set(key, { tagA: r.tagA, tagB: r.tagB, posts: r.posts, viralPosts: r.viralPosts, viewsSum: r.viewsSum });
    }
  }

  const idSet = new Set<number>();
  for (const e of merged.values()) {
    idSet.add(e.tagA);
    idSet.add(e.tagB);
  }
  const nameRows = await db.select({ id: hashtags.id, name: hashtags.name }).from(hashtags).where(inArray(hashtags.id, [...idSet]));
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  return [...merged.values()].map((e) => ({
    tagAId: e.tagA,
    tagAName: nameById.get(e.tagA) ?? "",
    tagBId: e.tagB,
    tagBName: nameById.get(e.tagB) ?? "",
    posts: e.posts,
    viralPosts: e.viralPosts,
    viewsSum: e.viewsSum,
  }));
}

/** Each tag's own total radar-sample post count and qualified-post
 * "strength" for the date, summed across platforms — the Jaccard
 * denominator and cluster-labelling ranking `buildClusters` needs. */
export async function getTagAggregatesForDate(db: Database, market: string, dateStr: string): Promise<{ tagTotalPosts: Map<number, number>; tagStrength: Map<number, number> }> {
  const rows = await db
    .select({
      hashtagId: hashtagDailyStats.hashtagId,
      totalPosts: sql<string>`sum(${hashtagDailyStats.postsSeen})`,
      strength: sql<string>`sum(${hashtagDailyStats.viralPosts} + ${hashtagDailyStats.breakoutPosts})`,
    })
    .from(hashtagDailyStats)
    .where(and(eq(hashtagDailyStats.market, market), eq(hashtagDailyStats.date, dateStr)))
    .groupBy(hashtagDailyStats.hashtagId);

  const tagTotalPosts = new Map<number, number>();
  const tagStrength = new Map<number, number>();
  for (const r of rows) {
    tagTotalPosts.set(r.hashtagId, Number(r.totalPosts));
    tagStrength.set(r.hashtagId, Number(r.strength));
  }
  return { tagTotalPosts, tagStrength };
}

function partnersFromEdges(edges: ClusterEdge[], maxPerTag: number): Map<number, string[]> {
  const partners = new Map<number, { name: string; posts: number }[]>();
  function add(tagId: number, otherName: string, posts: number): void {
    if (!otherName) return;
    const list = partners.get(tagId) ?? [];
    list.push({ name: otherName, posts });
    partners.set(tagId, list);
  }
  for (const e of edges) {
    add(e.tagAId, e.tagBName, e.posts);
    add(e.tagBId, e.tagAName, e.posts);
  }
  const result = new Map<number, string[]>();
  for (const [tagId, list] of partners) {
    result.set(
      tagId,
      list
        .sort((a, b) => b.posts - a.posts)
        .slice(0, maxPerTag)
        .map((p) => p.name),
    );
  }
  return result;
}

function byQualifiedDesc(a: TagItem, b: TagItem): number {
  return b.qualifiedPosts24h - a.qualifiedPosts24h || b.radarPosts24h - a.radarPosts24h || a.tag.localeCompare(b.tag);
}

export interface HashtagSections {
  breakout: TagItem[];
  rising: TagItem[];
  topByQualifiedPosts: TagItem[];
}

/** Reuses today's already-persisted `hashtag_daily_stats`/`tracked_hashtags`
 * rows (Phase 6 output) — no parallel trend computation here. `relatedTags`
 * comes from the same co-occurrence edges the cluster builder uses, kept
 * bounded per tag. */
export async function getHashtagSections(db: Database, market: string, now: Date, clusterEdges: ClusterEdge[]): Promise<HashtagSections> {
  const dateStr = now.toISOString().slice(0, 10);
  const rows = await db
    .select({
      hashtagId: trackedHashtags.hashtagId,
      name: hashtags.name,
      platform: trackedHashtags.platform,
      trendState: trackedHashtags.trendState,
      momentum: trackedHashtags.momentum,
      postsSeen: hashtagDailyStats.postsSeen,
      viralPosts: hashtagDailyStats.viralPosts,
      breakoutPosts: hashtagDailyStats.breakoutPosts,
      distinctCreators: hashtagDailyStats.distinctCreators,
      medianVph: hashtagDailyStats.medianVph,
    })
    .from(trackedHashtags)
    .innerJoin(hashtags, eq(hashtags.id, trackedHashtags.hashtagId))
    .leftJoin(
      hashtagDailyStats,
      and(
        eq(hashtagDailyStats.hashtagId, trackedHashtags.hashtagId),
        eq(hashtagDailyStats.platform, trackedHashtags.platform),
        eq(hashtagDailyStats.market, trackedHashtags.market),
        eq(hashtagDailyStats.date, dateStr),
      ),
    )
    .where(eq(trackedHashtags.market, market));

  const relatedByTag = partnersFromEdges(clusterEdges, 5);

  const items: TagItem[] = rows.map((r) => ({
    tag: r.name,
    platform: r.platform,
    trendState: r.trendState,
    radarPosts24h: r.postsSeen ?? 0,
    qualifiedPosts24h: (r.viralPosts ?? 0) + (r.breakoutPosts ?? 0),
    distinctCreators24h: r.distinctCreators ?? 0,
    medianVph: r.medianVph !== null ? Number(r.medianVph) : null,
    radarMomentum: r.momentum !== null ? Number(r.momentum) : null,
    relatedTags: relatedByTag.get(r.hashtagId) ?? [],
  }));

  return {
    breakout: items
      .filter((i) => i.trendState === "BREAKOUT")
      .sort(byQualifiedDesc)
      .slice(0, HASHTAG_SECTION_MAX),
    rising: items
      .filter((i) => i.trendState === "RISING")
      .sort(byQualifiedDesc)
      .slice(0, HASHTAG_SECTION_MAX),
    topByQualifiedPosts: [...items].sort(byQualifiedDesc).slice(0, HASHTAG_SECTION_MAX),
  };
}

export interface TierEventsResult {
  newlyTracked: string[];
  demoted: string[];
}

/** From actual `hashtag_tier_events` rows inside the report window — never
 * inferred by diffing current tiers (brief §29). A brand-new tag has
 * `fromTier IS NULL`; a demotion is the only transition that ever targets
 * DORMANT with a non-null `fromTier` (see core/lifecycle/hashtag-
 * lifecycle.ts — promotions never target DORMANT). */
export async function getTierEvents(db: Database, market: string, windowStart: Date, windowEnd: Date): Promise<TierEventsResult> {
  const rows = await db
    .select({ name: hashtags.name, fromTier: hashtagTierEvents.fromTier, toTier: hashtagTierEvents.toTier })
    .from(hashtagTierEvents)
    .innerJoin(trackedHashtags, eq(trackedHashtags.id, hashtagTierEvents.trackedHashtagId))
    .innerJoin(hashtags, eq(hashtags.id, trackedHashtags.hashtagId))
    .where(and(eq(trackedHashtags.market, market), gte(hashtagTierEvents.at, windowStart), lt(hashtagTierEvents.at, windowEnd)));

  return {
    newlyTracked: [...new Set(rows.filter((r) => r.fromTier === null).map((r) => r.name))],
    demoted: [...new Set(rows.filter((r) => r.toTier === "DORMANT" && r.fromTier !== null).map((r) => r.name))],
  };
}

/** Freezes the collection-side numbers a report needs entirely from
 * already-persisted `collection_runs`/`provider_jobs`/`posts`/
 * `post_snapshots` rows — never inferred from report-item counts (brief
 * §22). `tagsFailed` stays empty: Phase 5 doesn't persist per-tag failure
 * attribution at job granularity, a documented scope trim rather than an
 * invented value. */
export async function getCollectionSummary(db: Database, market: string, windowStart: Date, windowEnd: Date): Promise<CollectionSummary> {
  const runs = await db
    .select({ id: collectionRuns.id, status: collectionRuns.status })
    .from(collectionRuns)
    .where(and(gte(collectionRuns.plannedAt, windowStart), lt(collectionRuns.plannedAt, windowEnd)));
  const runsFailed = runs.filter((r) => r.status === "FAILED").length;
  const runsPartial = runs.filter((r) => r.status === "PARTIAL").length;

  const jobRows = await db
    .select({ platform: providerJobs.platform, recordsReturned: providerJobs.recordsReturned })
    .from(providerJobs)
    .innerJoin(collectionRuns, eq(collectionRuns.id, providerJobs.collectionRunId))
    .where(and(gte(collectionRuns.plannedAt, windowStart), lt(collectionRuns.plannedAt, windowEnd)));

  const postsScannedByPlatform: Record<Platform, number> = { tiktok: 0, instagram: 0 };
  let postsScannedTotal = 0;
  for (const j of jobRows) {
    const n = j.recordsReturned ?? 0;
    postsScannedByPlatform[j.platform] += n;
    postsScannedTotal += n;
  }

  const [uniqueRow] = await db
    .select({ n: sql<string>`count(distinct ${postSnapshots.postId})` })
    .from(postSnapshots)
    .where(and(gte(postSnapshots.observedAt, windowStart), lt(postSnapshots.observedAt, windowEnd)));
  const [snapRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(postSnapshots)
    .where(and(gte(postSnapshots.observedAt, windowStart), lt(postSnapshots.observedAt, windowEnd)));
  const [newRow] = await db
    .select({ n: sql<string>`count(*)` })
    .from(posts)
    .where(and(eq(posts.market, market), gte(posts.firstSeenAt, windowStart), lt(posts.firstSeenAt, windowEnd)));
  const [tagsRow] = await db
    .select({ n: sql<string>`count(distinct ${trackedHashtags.id})` })
    .from(trackedHashtags)
    .where(and(eq(trackedHashtags.market, market), gte(trackedHashtags.lastScannedAt, windowStart), lt(trackedHashtags.lastScannedAt, windowEnd)));

  const usage = await getProviderUsageSince(db, windowStart);

  return {
    runs: runs.length,
    runsFailed,
    runsPartial,
    postsScannedTotal,
    postsScannedByPlatform,
    uniquePosts: Number(uniqueRow?.n ?? "0"),
    newPosts: Number(newRow?.n ?? "0"),
    snapshots: Number(snapRow?.n ?? "0"),
    recordsUsed: usage.recordsUsed,
    estCostUsd: Number(usage.costUsd),
    tagsScanned: Number(tagsRow?.n ?? "0"),
    tagsFailed: [],
  };
}

export interface PlatformCollectionOutcome {
  jobs: number;
  failed: number;
}

/** Per-platform job outcome within the window — the real, persisted basis
 * for a `<platform>:discovery_failed`/`<platform>:discovery_partial`
 * partial reason (brief §20-21), never inferred from how few posts ended
 * up in the report. */
export async function getPlatformCollectionOutcomes(db: Database, windowStart: Date, windowEnd: Date): Promise<Record<Platform, PlatformCollectionOutcome>> {
  const rows = await db
    .select({ platform: providerJobs.platform, status: providerJobs.status })
    .from(providerJobs)
    .innerJoin(collectionRuns, eq(collectionRuns.id, providerJobs.collectionRunId))
    .where(and(gte(collectionRuns.plannedAt, windowStart), lt(collectionRuns.plannedAt, windowEnd)));

  const result: Record<Platform, PlatformCollectionOutcome> = { tiktok: { jobs: 0, failed: 0 }, instagram: { jobs: 0, failed: 0 } };
  for (const r of rows) {
    result[r.platform].jobs += 1;
    if (r.status === "FAILED" || r.status === "TIMED_OUT") result[r.platform].failed += 1;
  }
  return result;
}

/** Any run still PLANNED/RUNNING at generation time within the window —
 * the persisted basis for a `collection:unfinished_jobs` partial reason. */
export async function hasUnfinishedCollectionRuns(db: Database, windowStart: Date, windowEnd: Date): Promise<boolean> {
  const rows = await db
    .select({ id: collectionRuns.id })
    .from(collectionRuns)
    .where(and(gte(collectionRuns.plannedAt, windowStart), lt(collectionRuns.plannedAt, windowEnd), inArray(collectionRuns.status, ["PLANNED", "RUNNING"])))
    .limit(1);
  return rows.length > 0;
}
