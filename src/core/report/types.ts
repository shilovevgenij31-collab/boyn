/**
 * DailyReport v1 (Phase 7 brief §7-8, plan §19) — a versioned, frozen
 * contract. Every field here is what actually gets persisted to
 * `daily_reports.payload`; Phase 8 (Telegram) and any future `/export`
 * consumer read ONLY this, never today's mutable `posts` table, so a
 * report stays reproducible even as posts keep changing after the fact.
 *
 * Uses `market`, never `locale` (Phase 7 brief §2 — the old plan's stale
 * wording). Hashtag momentum/growth fields are explicitly "Radar" —
 * scoped to our own monitored sample, never a platform-wide claim
 * (CLAUDE.md rule 13 / brief §28).
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";
import type { Market } from "@/core/domain/market.ts";
import type { PostTier } from "@/core/analytics/qualification.ts";
import type { TrendState } from "@/core/domain/tracking.ts";
import type { VelocityConfidence, VelocityKind } from "@/core/analytics/velocity.ts";
import type { ComponentDetail } from "@/core/analytics/scoring.ts";

export const DAILY_REPORT_SCHEMA_VERSION = 1;

export type ReportStatus = "COMPLETE" | "PARTIAL";

/**
 * Machine-readable, closed-ish vocabulary (brief §20) — kept as a plain
 * string rather than a fixed union so a new, still-concise reason never
 * requires a type change; callers only ever construct these from real
 * persisted signals, never invent one.
 */
export type PartialReason = string;

export interface ReportItem {
  rank: number;
  postId: number;
  platform: Platform;
  /** Always the Phase 2 canonical tiktok.com/instagram.com permalink —
   * never a provider/CDN URL (brief §9). */
  canonicalUrl: string;
  externalId: string;

  creatorUsername: string | null;
  /** Bounded preview (config/report.ts's CAPTION_PREVIEW_MAX_CHARS), not
   * the full provider caption (brief §68). */
  captionPreview: string | null;
  hashtags: string[];
  categories: Category[];

  publishedAt: string | null;
  ageHours: number | null;

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

  /** Structured, auditable breakdown (Phase 6's explainScore output) —
   * never natural-language prose. */
  scoreComponents: { trend: ComponentDetail[]; rising: ComponentDetail[] } | null;

  /** Which window this item was selected under — set by the caller
   * (build-daily-report.ts), not derived from age alone, since Still Hot
   * and Today use the exact same underlying candidate shape. "LIVE" is a
   * Phase 8 addition: a Telegram current-state view (`/rising`,
   * `/tiktok`, category filters, ...) computed at command time rather
   * than sourced from a frozen DailyReport. */
  window: "TODAY" | "STILL_HOT" | "RISING_NOW" | "EXPORT_ONLY" | "LIVE";

  /** Computed from the previous frozen report by stable postId (brief
   * §26) — never by URL comparison. */
  inYesterdayReport: boolean;
}

export interface TagItem {
  tag: string;
  platform: Platform;
  trendState: TrendState;
  /** Radar-sample post volume (last 24h) — never phrased as platform-wide
   * (brief §28). */
  radarPosts24h: number;
  qualifiedPosts24h: number;
  distinctCreators24h: number;
  medianVph: number | null;
  radarMomentum: number | null;
  relatedTags: string[];
}

export interface ClusterItem {
  label: string;
  tags: string[];
  qualifiedPosts: number;
  viewsSum: number | null;
  /** Ranks of `todayTop`/`stillHot` items that carry one of this
   * cluster's tags, where known — lets Phase 8 cross-reference without
   * a second query. */
  sampleRanks: number[];
}

export interface CollectionSummary {
  runs: number;
  runsFailed: number;
  runsPartial: number;
  postsScannedTotal: number;
  postsScannedByPlatform: Record<Platform, number>;
  uniquePosts: number;
  newPosts: number;
  snapshots: number;
  recordsUsed: number;
  estCostUsd: number;
  tagsScanned: number;
  tagsFailed: string[];
}

export interface ReportCounts {
  /** Explicitly the 24h Today window (brief §23) — not lifetime totals. */
  viralQualified: number;
  earlyBreakout: number;
  watch: number;
}

export interface ReportDistribution {
  /** Over the Today candidate pool (brief §24) — multi-label categories
   * mean these can sum to more than the pool size, which is expected. */
  platform: Record<Platform, number>;
  category: Partial<Record<Category, number>>;
}

export interface MetricDelta {
  current: number;
  previous: number | null;
  /** `null` when there is no previous report to compare against — never
   * a fabricated 0% (brief §25). */
  delta: number | null;
}

export interface DailyReportComparisons {
  vsYesterday: {
    viralQualified: MetricDelta;
    earlyBreakout: MetricDelta;
    postsScanned: MetricDelta;
  } | null;
}

export interface DailyReport {
  schemaVersion: 1;
  scoringVersion: number;

  reportDate: string; // YYYY-MM-DD, in REPORT_TZ
  timezone: string;
  market: Market;

  generatedAt: string;
  window: { start: string; end: string };

  status: ReportStatus;
  partialReasons: PartialReason[];

  collection: CollectionSummary;
  counts: ReportCounts;
  distribution: ReportDistribution;

  todayTop: ReportItem[];
  stillHot: ReportItem[];
  risingNow: ReportItem[];

  hashtags: {
    breakout: TagItem[];
    rising: TagItem[];
    topByQualifiedPosts: TagItem[];
    newlyTracked: string[];
    demoted: string[];
  };

  clusters: ClusterItem[];

  comparisons: DailyReportComparisons;

  /** Frozen pool for CSV/manual analysis (brief §18) — deduplicated by
   * postId, up to config/report.ts's EXPORT_CANDIDATES_MAX. */
  exportCandidates: ReportItem[];
}
