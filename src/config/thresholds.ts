/**
 * Viral-candidate / post-tier thresholds (Phase 6), from
 * docs/IMPLEMENTATION_PLAN.md §15. `SCORING_VERSION` (config/scoring.ts)
 * marks these as v1 defaults — deterministic and reasoned about, but NOT
 * empirically calibrated against real production data yet (that's
 * Phase 11, after >=7 days of real collection). Do not read these numbers
 * as statistically final.
 */

/** Data-quality exclusion (§15): a post failing any of these is stored
 * (for dedup / hashtag denominators) but never tier-classified above
 * NOISE and never ranked. */
export const DATA_QUALITY = {
  requireViews: true,
  requirePublishedAt: true,
  requireVideoOrCarousel: true, // non-video/reel/carousel content is excluded
} as const;

export const EARLY_BREAKOUT_THRESHOLDS = {
  minAgeHours: 0.5,
  maxAgeHours: 8,
  minViews: 20_000,
  minVph: 10_000,
  /** Confidence gate: MEDIUM+ satisfies it directly; a HIGH view count
   * alone (>= this) also qualifies even at LOW/MEDIUM velocity confidence
   * (Phase 1 decision: EARLY_BREAKOUT must not require full engagement
   * metrics — see module doc comment). */
  viewsFloorForLowConfidence: 50_000,
} as const;

export const VIRAL_QUALIFIED_THRESHOLDS = {
  minViews: 100_000,
  maxAgeHours: 72,
} as const;

export const WATCH_THRESHOLDS = {
  maxAgeHours: 24,
  minViews: 5_000,
  minVph: 1_500,
} as const;

/** Availability-aware engagement floor (§15): applies only to whichever
 * of comments/shares the provider actually returned. Missing both simply
 * skips the floor (never auto-rejects) but caps confidence at MEDIUM. */
export const ENGAGEMENT_FLOOR = {
  minComments: 5,
  minShares: 10,
} as const;

/** Noise guards (§15 bottom). */
export const NOISE_GUARDS = {
  /** Estimated-velocity age denominator floor — a 50K-view post at 10 min
   * old must not read as 300K/h. */
  minEstimationAgeHours: 1,
  /** Observed snapshot intervals shorter than this are not trustworthy
   * enough to call a real interval; merged/skipped instead. */
  minObservedIntervalHours: 0.75,
} as const;
