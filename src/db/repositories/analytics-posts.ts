/**
 * Post-side analytics queries/persistence (Phase 6 brief §6-7, §24, §50).
 * Batch-fetches bounded windows and lets core/analytics/* do the actual
 * math — no scoring logic here, just I/O (brief §50).
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { hashtags, postCategories, postHashtags, posts, postSnapshots } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { ContentType } from "@/core/domain/content-type.ts";
import type { Category } from "@/core/domain/category.ts";
import type { TrendState } from "@/core/domain/tracking.ts";
import type { PostTier } from "@/core/analytics/qualification.ts";
import type { VelocityConfidence, VelocityKind } from "@/core/analytics/velocity.ts";

export interface AnalyticsPostRow {
  id: number;
  platform: Platform;
  externalId: string;
  market: string;
  contentType: ContentType;
  availability: "ACTIVE" | "DELETED" | "PRIVATE" | "UNKNOWN";
  publishedAt: Date | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  creatorUsername: string | null;
  creatorExternalId: string | null;
  caption: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  trendState: TrendState | null;
  trendStateSince: Date | null;
  paidRefreshCount: number;
  nextRefreshAt: Date | null;
}

/**
 * Posts worth (re)scoring this run: published (or still being newly
 * seen) within the analytics horizon. Older posts remain in the DB
 * untouched (brief §6 — retention is a Phase 7 concern), simply excluded
 * from this query so they aren't rescored every run.
 */
export async function getPostsEligibleForScoring(db: Database, market: string, now: Date, horizonHours: number): Promise<AnalyticsPostRow[]> {
  const horizonStart = new Date(now.getTime() - horizonHours * 3_600_000);
  return db
    .select({
      id: posts.id,
      platform: posts.platform,
      externalId: posts.externalId,
      market: posts.market,
      contentType: posts.contentType,
      availability: posts.availability,
      publishedAt: posts.publishedAt,
      views: posts.views,
      likes: posts.likes,
      comments: posts.comments,
      shares: posts.shares,
      creatorUsername: posts.creatorUsername,
      creatorExternalId: posts.creatorExternalId,
      caption: posts.caption,
      firstSeenAt: posts.firstSeenAt,
      lastSeenAt: posts.lastSeenAt,
      trendState: posts.trendState,
      trendStateSince: posts.trendStateSince,
      paidRefreshCount: posts.paidRefreshCount,
      nextRefreshAt: posts.nextRefreshAt,
    })
    .from(posts)
    .where(and(eq(posts.market, market), gte(posts.lastSeenAt, horizonStart)));
}

export interface SnapshotRow {
  postId: number;
  observedAt: Date;
  views: number | null;
}

/** One batched query for every eligible post's snapshot history —
 * avoids an N+1 (brief §50). Caller groups by postId. */
export async function getSnapshotsForPosts(db: Database, postIds: number[]): Promise<SnapshotRow[]> {
  if (postIds.length === 0) return [];
  return db
    .select({ postId: postSnapshots.postId, observedAt: postSnapshots.observedAt, views: postSnapshots.views })
    .from(postSnapshots)
    .where(inArray(postSnapshots.postId, postIds));
}

export interface PostHashtagRow {
  postId: number;
  hashtagId: number;
  name: string;
  isGeneric: boolean;
  isBlocked: boolean;
}

/** One batched query for every eligible post's hashtag associations. */
export async function getHashtagsForPosts(db: Database, postIds: number[]): Promise<PostHashtagRow[]> {
  if (postIds.length === 0) return [];
  return db
    .select({ postId: postHashtags.postId, hashtagId: hashtags.id, name: hashtags.name, isGeneric: hashtags.isGeneric, isBlocked: hashtags.isBlocked })
    .from(postHashtags)
    .innerJoin(hashtags, eq(hashtags.id, postHashtags.hashtagId))
    .where(inArray(postHashtags.postId, postIds));
}

export interface PostScoreUpdate {
  vph: number | null;
  vphKind: VelocityKind;
  velocityConfidence: VelocityConfidence;
  trendScore: number | null;
  risingScore: number | null;
  scoreComponents: Record<string, unknown>;
  scoredAt: Date;
  scoringVersion: number;
  tier: PostTier | null;
  trendState: TrendState | null;
  trendStateSince: Date | null;
  nextRefreshAt: Date | null;
}

export async function updatePostScore(db: Database, postId: number, update: PostScoreUpdate): Promise<void> {
  await db
    .update(posts)
    .set({
      vph: update.vph !== null ? update.vph.toFixed(2) : null,
      vphKind: update.vphKind === "NONE" ? null : update.vphKind,
      velocityConfidence: update.velocityConfidence,
      trendScore: update.trendScore,
      risingScore: update.risingScore,
      scoreComponents: update.scoreComponents,
      scoredAt: update.scoredAt,
      scoringVersion: update.scoringVersion,
      tier: update.tier,
      trendState: update.trendState,
      trendStateSince: update.trendStateSince,
      nextRefreshAt: update.nextRefreshAt,
    })
    .where(eq(posts.id, postId));
}

/** Replaces a post's category set with the freshly-computed one — dedup
 * is inherent (the PK is (postId, category)), and a full replace (delete
 * + insert within the same transaction) keeps reruns idempotent even
 * when a category's evidence disappears (e.g. a caption edit — never
 * observed in practice, but the repository stays correct either way). */
export async function replacePostCategories(db: Database, postId: number, categories: { category: Category; confidence: number; source: "TAG" | "QUERY" | "KEYWORD" | "AI" }[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(postCategories).where(eq(postCategories.postId, postId));
    if (categories.length === 0) return;
    await tx.insert(postCategories).values(
      categories.map((c) => ({ postId, category: c.category, confidence: c.confidence.toFixed(3), source: c.source })),
    );
  });
}

export async function getPostCategoriesBulk(db: Database, postIds: number[]): Promise<{ postId: number; category: Category; confidence: string }[]> {
  if (postIds.length === 0) return [];
  return db
    .select({ postId: postCategories.postId, category: postCategories.category, confidence: postCategories.confidence })
    .from(postCategories)
    .where(inArray(postCategories.postId, postIds));
}

/** Views/creator identity for co-occurrence & daily-stats aggregation —
 * kept separate from the main eligible-posts query since callers that
 * only need daily-stats aggregation don't need the full row. */
export async function getPostsSeenToday(db: Database, platform: Platform, market: string, dayStart: Date, dayEnd: Date): Promise<
  { id: number; tier: PostTier | null; views: number | null; vph: string | null; creatorUsername: string | null; creatorExternalId: string | null }[]
> {
  return db
    .select({ id: posts.id, tier: posts.tier, views: posts.views, vph: posts.vph, creatorUsername: posts.creatorUsername, creatorExternalId: posts.creatorExternalId })
    .from(posts)
    .where(and(eq(posts.platform, platform), eq(posts.market, market), gte(posts.lastSeenAt, dayStart), sql`${posts.lastSeenAt} < ${dayEnd}`));
}
