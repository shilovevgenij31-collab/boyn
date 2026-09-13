/**
 * Deterministic post-tier qualification (Phase 6 brief §26-27, plan §15).
 * `posts.tier` (VIRAL_QUALIFIED/EARLY_BREAKOUT/WATCH/NOISE) is the
 * "qualification" concept — distinct from posts.trend_state (trend-
 * state.ts), which describes momentum, not a fixed reach/freshness bar.
 */
import {
  DATA_QUALITY,
  EARLY_BREAKOUT_THRESHOLDS,
  ENGAGEMENT_FLOOR,
  VIRAL_QUALIFIED_THRESHOLDS,
  WATCH_THRESHOLDS,
} from "@/config/thresholds.ts";
import type { VelocityConfidence } from "./velocity.ts";
import type { ContentType } from "@/core/domain/content-type.ts";

export type PostTier = "VIRAL_QUALIFIED" | "EARLY_BREAKOUT" | "WATCH" | "NOISE";

export interface QualificationInput {
  views: number | null;
  publishedAt: Date | null;
  contentType: ContentType;
  availability: "ACTIVE" | "DELETED" | "PRIVATE" | "UNKNOWN";
  ageHours: number;
  vph: number | null;
  vphConfidence: VelocityConfidence;
  comments: number | null;
  shares: number | null;
}

export interface QualificationResult {
  /** `null` = data-quality excluded: stored, never ranked (plan §15). */
  tier: PostTier | null;
  /** True whenever EARLY_BREAKOUT's own criteria clear, even if the
   * final `tier` ended up VIRAL_QUALIFIED instead (plan §15: "a post can
   * be both ... labelled VIRAL_QUALIFIED with a breakout flag"). */
  isEarlyBreakoutEligible: boolean;
  /** Set when the engagement floor was skipped because neither comments
   * nor shares were available — velocity confidence alone can't reach
   * HIGH in that case (plan §15). */
  confidenceCap: "MEDIUM" | null;
}

function isDataQualityExcluded(input: QualificationInput): boolean {
  if (DATA_QUALITY.requireViews && input.views === null) return true;
  if (DATA_QUALITY.requirePublishedAt && input.publishedAt === null) return true;
  if (DATA_QUALITY.requireVideoOrCarousel && input.contentType !== "video" && input.contentType !== "reel" && input.contentType !== "carousel") {
    return true;
  }
  if (input.availability !== "ACTIVE") return true;
  return false;
}

interface EngagementFloorResult {
  passes: boolean;
  confidenceCap: "MEDIUM" | null;
}

function checkEngagementFloor(comments: number | null, shares: number | null): EngagementFloorResult {
  const commentsAvailable = comments !== null;
  const sharesAvailable = shares !== null;
  if (!commentsAvailable && !sharesAvailable) return { passes: true, confidenceCap: "MEDIUM" };
  if (commentsAvailable && sharesAvailable) {
    return { passes: comments! >= ENGAGEMENT_FLOOR.minComments || shares! >= ENGAGEMENT_FLOOR.minShares, confidenceCap: null };
  }
  if (commentsAvailable) return { passes: comments! >= ENGAGEMENT_FLOOR.minComments, confidenceCap: null };
  return { passes: shares! >= ENGAGEMENT_FLOOR.minShares, confidenceCap: null };
}

export function classifyPostTier(input: QualificationInput): QualificationResult {
  if (isDataQualityExcluded(input)) {
    return { tier: null, isEarlyBreakoutEligible: false, confidenceCap: null };
  }

  const views = input.views!;
  const floor = checkEngagementFloor(input.comments, input.shares);

  const confidenceOk = input.vphConfidence === "HIGH" || input.vphConfidence === "MEDIUM";
  const isEarlyBreakoutEligible =
    input.ageHours >= EARLY_BREAKOUT_THRESHOLDS.minAgeHours &&
    input.ageHours <= EARLY_BREAKOUT_THRESHOLDS.maxAgeHours &&
    views >= EARLY_BREAKOUT_THRESHOLDS.minViews &&
    (input.vph ?? 0) >= EARLY_BREAKOUT_THRESHOLDS.minVph &&
    (confidenceOk || views >= EARLY_BREAKOUT_THRESHOLDS.viewsFloorForLowConfidence) &&
    floor.passes;

  const isViralQualified = views >= VIRAL_QUALIFIED_THRESHOLDS.minViews && input.ageHours <= VIRAL_QUALIFIED_THRESHOLDS.maxAgeHours;

  const isWatch =
    input.ageHours <= WATCH_THRESHOLDS.maxAgeHours &&
    views >= WATCH_THRESHOLDS.minViews &&
    (input.vph ?? 0) >= WATCH_THRESHOLDS.minVph;

  const tier: PostTier = isViralQualified ? "VIRAL_QUALIFIED" : isEarlyBreakoutEligible ? "EARLY_BREAKOUT" : isWatch ? "WATCH" : "NOISE";

  return { tier, isEarlyBreakoutEligible, confidenceCap: floor.confidenceCap };
}
