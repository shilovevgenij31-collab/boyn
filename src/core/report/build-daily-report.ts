/**
 * DailyReport assembly (Phase 7 brief §6-9, plan §19). Pure and
 * framework-free: every input here is already-fetched plain data
 * (src/db/repositories/report-data.ts does the querying); this module
 * only decides window membership, ranking, and frozen shape.
 *
 * Window boundaries (brief §1, §58) — deterministic half-open partition,
 * chosen so a post published at EXACTLY the 24h/72h boundary never
 * appears in two sections or neither:
 *   TODAY:      windowStart <= publishedAt <= windowEnd   (both inclusive)
 *   STILL_HOT:  stillHotStart <= publishedAt <  windowStart (upper exclusive)
 * A post older than stillHotStart is excluded from both — never ranked
 * in this report at all, even if it still exists in the DB.
 */
import { REPORT_WINDOW_HOURS, TODAY_TOP_CONFIG, STILL_HOT_MAX, RISING_NOW_MAX, EXPORT_CANDIDATES_MAX, CAPTION_PREVIEW_MAX_CHARS } from "@/config/report.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";
import type { Market } from "@/core/domain/market.ts";
import type { ContentType } from "@/core/domain/content-type.ts";
import type { TrendState } from "@/core/domain/tracking.ts";
import type { PostTier } from "@/core/analytics/qualification.ts";
import type { VelocityConfidence, VelocityKind } from "@/core/analytics/velocity.ts";
import type { ComponentDetail } from "@/core/analytics/scoring.ts";
import { selectTodayTop, type TopCandidate } from "./select-top.ts";
import { selectRisingNow } from "./select-rising.ts";
import { computeDelta } from "./comparison.ts";
import { buildClusters, type ClusterEdge } from "./build-clusters.ts";
import { CLUSTER_CONFIG } from "@/config/report.ts";
import {
  DAILY_REPORT_SCHEMA_VERSION,
  type ClusterItem,
  type CollectionSummary,
  type DailyReport,
  type PartialReason,
  type ReportItem,
  type ReportStatus,
  type TagItem,
} from "./types.ts";

export interface CandidatePost {
  postId: number;
  platform: Platform;
  externalId: string;
  canonicalUrl: string;
  creatorUsername: string | null;
  caption: string | null;
  hashtags: string[];
  categories: Category[];
  publishedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  vph: number | null;
  vphKind: VelocityKind;
  velocityConfidence: VelocityConfidence;
  trendScore: number | null;
  risingScore: number | null;
  trendState: TrendState | null;
  tier: PostTier | null;
  scoreComponents: { trend: ComponentDetail[]; rising: ComponentDetail[] } | null;
  availability: "ACTIVE" | "DELETED" | "PRIVATE" | "UNKNOWN";
  contentType: ContentType;
}

export interface YesterdayComparisonInput {
  viralQualified: number;
  earlyBreakout: number;
  postsScanned: number;
}

export interface BuildDailyReportInput {
  now: Date;
  reportDate: string;
  timezone: string;
  market: Market;
  scoringVersion: number;

  candidatePosts: CandidatePost[];
  yesterdayPostIds: ReadonlySet<number>;
  yesterday: YesterdayComparisonInput | null;

  collection: CollectionSummary;
  partialReasons: PartialReason[];

  hashtagSections: { breakout: TagItem[]; rising: TagItem[]; topByQualifiedPosts: TagItem[] };
  newlyTracked: string[];
  demoted: string[];

  clusterEdges: ClusterEdge[];
  tagTotalPosts: Map<number, number>;
  tagStrength: Map<number, number>;
}

/** Plan §19's Today/Still-Hot pool: VIRAL_QUALIFIED, or EARLY_BREAKOUT
 * with at least MEDIUM velocity confidence — ACTIVE, video/reel only,
 * and never a post whose OWN trend state says it's already DEAD. Does
 * not duplicate a second qualification engine; reuses Phase 6's tier. */
function isRankable(p: CandidatePost): boolean {
  if (p.availability !== "ACTIVE") return false;
  if (p.contentType !== "video" && p.contentType !== "reel") return false;
  if (p.trendState === "DEAD") return false;
  if (p.trendScore === null) return false;
  if (p.tier === "VIRAL_QUALIFIED") return true;
  if (p.tier === "EARLY_BREAKOUT" && (p.velocityConfidence === "MEDIUM" || p.velocityConfidence === "HIGH")) return true;
  return false;
}

function creatorKey(p: CandidatePost): string {
  return p.creatorUsername ? `${p.platform}:${p.creatorUsername}` : `${p.platform}:anon:${p.postId}`;
}

function toTopCandidate(p: CandidatePost): TopCandidate & { post: CandidatePost } {
  return {
    postId: p.postId,
    platform: p.platform,
    creatorKey: creatorKey(p),
    trendScore: p.trendScore ?? 0,
    risingScore: p.risingScore ?? 0,
    vph: p.vph ?? 0,
    views: p.views ?? 0,
    publishedAtMs: p.publishedAt.getTime(),
    post: p,
  };
}

function truncateCaption(caption: string | null): string | null {
  if (caption === null) return null;
  return caption.length > CAPTION_PREVIEW_MAX_CHARS ? `${caption.slice(0, CAPTION_PREVIEW_MAX_CHARS)}…` : caption;
}

/** `ageHours` starts null and is filled in by `withAge` once the report's
 * `now` is available — kept as a separate step so this function stays a
 * simple, reusable field mapper. */
function toReportItem(p: CandidatePost, rank: number, window: ReportItem["window"], inYesterdayReport: boolean): ReportItem {
  return {
    rank,
    postId: p.postId,
    platform: p.platform,
    canonicalUrl: p.canonicalUrl,
    externalId: p.externalId,
    creatorUsername: p.creatorUsername,
    captionPreview: truncateCaption(p.caption),
    hashtags: p.hashtags,
    categories: p.categories,
    publishedAt: p.publishedAt.toISOString(),
    ageHours: null, // set by caller (needs `now`)
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    vph: p.vph,
    vphKind: p.vphKind,
    velocityConfidence: p.velocityConfidence,
    trendScore: p.trendScore,
    risingScore: p.risingScore,
    trendState: p.trendState,
    tier: p.tier,
    scoreComponents: p.scoreComponents,
    window,
    inYesterdayReport,
  };
}

export function buildDailyReport(input: BuildDailyReportInput): DailyReport {
  const windowEnd = input.now;
  const windowStart = new Date(windowEnd.getTime() - REPORT_WINDOW_HOURS.today * 3_600_000);
  const stillHotStart = new Date(windowEnd.getTime() - REPORT_WINDOW_HOURS.stillHotOuter * 3_600_000);

  const rankable = input.candidatePosts.filter(isRankable);
  const todayPool = rankable.filter((p) => p.publishedAt.getTime() >= windowStart.getTime() && p.publishedAt.getTime() <= windowEnd.getTime());
  const stillHotPool = rankable.filter((p) => p.publishedAt.getTime() >= stillHotStart.getTime() && p.publishedAt.getTime() < windowStart.getTime());

  const todaySelected = selectTodayTop(todayPool.map(toTopCandidate), TODAY_TOP_CONFIG);
  const stillHotSelected = [...stillHotPool.map(toTopCandidate)]
    .sort((a, b) => b.trendScore - a.trendScore || b.risingScore - a.risingScore || a.postId - b.postId)
    .slice(0, STILL_HOT_MAX);

  const risingPool = [...todayPool, ...stillHotPool].map(toTopCandidate);
  const risingSelected = selectRisingNow(
    risingPool.map((c) => ({ postId: c.postId, risingScore: c.risingScore, vph: c.vph, publishedAtMs: c.publishedAtMs })),
    RISING_NOW_MAX,
  );
  const risingIds = new Set(risingSelected.map((c) => c.postId));
  const risingPosts = risingPool.filter((c) => risingIds.has(c.postId));

  function withAge(item: ReportItem, publishedAt: Date): ReportItem {
    return { ...item, ageHours: Math.max(0, (windowEnd.getTime() - publishedAt.getTime()) / 3_600_000) };
  }

  const todayTop: ReportItem[] = todaySelected.map((c, i) => withAge(toReportItem(c.post, i + 1, "TODAY", input.yesterdayPostIds.has(c.postId)), c.post.publishedAt));
  const stillHot: ReportItem[] = stillHotSelected.map((c, i) => withAge(toReportItem(c.post, i + 1, "STILL_HOT", input.yesterdayPostIds.has(c.postId)), c.post.publishedAt));
  const risingNow: ReportItem[] = risingPosts
    .sort((a, b) => b.risingScore - a.risingScore || a.postId - b.postId)
    .map((c, i) => withAge(toReportItem(c.post, i + 1, "RISING_NOW", input.yesterdayPostIds.has(c.postId)), c.post.publishedAt));

  const exportMap = new Map<number, ReportItem>();
  for (const item of [...todayTop, ...stillHot, ...risingNow]) {
    if (!exportMap.has(item.postId)) exportMap.set(item.postId, { ...item, window: "EXPORT_ONLY" });
  }
  const exportCandidates = [...exportMap.values()]
    .sort((a, b) => (b.trendScore ?? 0) - (a.trendScore ?? 0) || a.postId - b.postId)
    .slice(0, EXPORT_CANDIDATES_MAX)
    .map((item, i) => ({ ...item, rank: i + 1 }));

  const status: ReportStatus = input.partialReasons.length > 0 ? "PARTIAL" : "COMPLETE";

  const platformDistribution: Record<Platform, number> = { tiktok: 0, instagram: 0 };
  const categoryDistribution: Partial<Record<Category, number>> = {};
  for (const p of todayPool) {
    platformDistribution[p.platform] += 1;
    for (const category of p.categories) categoryDistribution[category] = (categoryDistribution[category] ?? 0) + 1;
  }

  const counts = {
    viralQualified: todayPool.filter((p) => p.tier === "VIRAL_QUALIFIED").length,
    earlyBreakout: todayPool.filter((p) => p.tier === "EARLY_BREAKOUT").length,
    watch: input.candidatePosts.filter((p) => p.tier === "WATCH" && p.publishedAt.getTime() >= windowStart.getTime() && p.publishedAt.getTime() <= windowEnd.getTime()).length,
  };

  const clusters: ClusterItem[] = buildClusters(input.clusterEdges, input.tagTotalPosts, input.tagStrength, CLUSTER_CONFIG).map((c) => ({
    label: c.label,
    tags: c.tags,
    qualifiedPosts: c.qualifiedPosts,
    viewsSum: c.viewsSum,
    sampleRanks: [...todayTop, ...stillHot]
      .filter((item) => item.hashtags.some((h) => c.tags.includes(h)))
      .map((item) => item.rank)
      .slice(0, 5),
  }));

  return {
    schemaVersion: DAILY_REPORT_SCHEMA_VERSION,
    scoringVersion: input.scoringVersion,
    reportDate: input.reportDate,
    timezone: input.timezone,
    market: input.market,
    generatedAt: windowEnd.toISOString(),
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    status,
    partialReasons: input.partialReasons,
    collection: input.collection,
    counts,
    distribution: { platform: platformDistribution, category: categoryDistribution },
    todayTop,
    stillHot,
    risingNow,
    hashtags: {
      breakout: input.hashtagSections.breakout,
      rising: input.hashtagSections.rising,
      topByQualifiedPosts: input.hashtagSections.topByQualifiedPosts,
      newlyTracked: input.newlyTracked,
      demoted: input.demoted,
    },
    clusters,
    comparisons: {
      vsYesterday: input.yesterday
        ? {
            viralQualified: computeDelta(counts.viralQualified, input.yesterday.viralQualified),
            earlyBreakout: computeDelta(counts.earlyBreakout, input.yesterday.earlyBreakout),
            postsScanned: computeDelta(input.collection.postsScannedTotal, input.yesterday.postsScanned),
          }
        : null,
    },
    exportCandidates,
  };
}
