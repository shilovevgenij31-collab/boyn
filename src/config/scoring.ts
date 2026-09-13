/**
 * TrendScore/RisingScore weights, robust-normalization parameters, and
 * analytics windows (Phase 6), from docs/IMPLEMENTATION_PLAN.md §16-17.
 * `SCORING_VERSION = 1` — a deterministic, reasoned-about v1, NOT yet
 * empirically calibrated (Phase 11 recalibrates after >=7 days of real
 * production data; see thresholds.ts's module comment for the same
 * caveat, which applies here too).
 */

export const SCORING_VERSION = 1;

// ---------------------------------------------------------------------------
// Analytics windows (§5 of the Phase 6 brief) — no scattered literals.
// ---------------------------------------------------------------------------

export const ANALYTICS_WINDOWS_HOURS = {
  /** Main "is this happening today" awareness window. */
  primary: 24,
  /** Current-ranking / "still worth showing" window. */
  ranking: 72,
  /** Robust reference/baseline window, in hours (7 days). */
  baseline: 7 * 24,
} as const;

// ---------------------------------------------------------------------------
// Velocity (§16.1)
// ---------------------------------------------------------------------------

export const VELOCITY_CONFIG = {
  /** Snapshot intervals shorter than this are not a real interval —
   * mirrors thresholds.ts's NOISE_GUARDS.minObservedIntervalHours; kept as
   * its own reference here since velocity.ts must not import thresholds.ts
   * (different concern) — see core/analytics/velocity.ts for the actual
   * single source of truth re-exported from thresholds.ts. */
  minObservedIntervalHours: 0.75,
  minEstimationAgeHours: 1,
} as const;

// ---------------------------------------------------------------------------
// Robust normalization (§16.2) — robust z on log scale, per (platform,
// market, metric), squashed through a logistic.
// ---------------------------------------------------------------------------

/** The metrics baselined per (platform, market) — matches
 * `scoring_baselines.metric` values persisted by the analytics job. */
export const BASELINE_METRICS = ["views", "vph", "like_ratio", "comment_ratio", "share_ratio"] as const;
export type BaselineMetric = (typeof BASELINE_METRICS)[number];

export const BASELINE_CONFIG = {
  /** Reference cohort: posts first seen in the trailing N days with
   * views >= this floor. */
  windowDays: 7,
  minViewsForCohort: 10_000,
  /** Below this sample size, the seeded default (not the tiny real
   * sample) is used — a median/MAD from 4 posts is not stable. */
  minSampleSize: 50,
  /** Asymmetric clip: upside outliers matter more than downside ones. */
  zClipMin: -3,
  zClipMax: 5,
} as const;

/** Seeded fallback baselines per (platform, metric), used until a
 * platform/market/metric has >= BASELINE_CONFIG.minSampleSize real
 * observations. Values are log1p-scale median/MAD, deliberately
 * conservative round numbers (v1 defaults, not measured) — see module
 * doc comment. `market` is intentionally omitted (defaults apply to any
 * market until that market accumulates its own real baseline). */
export const DEFAULT_BASELINES: Record<string, { medianLog1p: number; madLog1p: number }> = {
  "tiktok:views": { medianLog1p: Math.log1p(30_000), madLog1p: 1.2 },
  "instagram:views": { medianLog1p: Math.log1p(15_000), madLog1p: 1.2 },
  "tiktok:vph": { medianLog1p: Math.log1p(2_000), madLog1p: 1.3 },
  "instagram:vph": { medianLog1p: Math.log1p(800), madLog1p: 1.3 },
  "tiktok:like_ratio": { medianLog1p: Math.log1p(0.05), madLog1p: 0.8 },
  "instagram:like_ratio": { medianLog1p: Math.log1p(0.03), madLog1p: 0.8 },
  "tiktok:comment_ratio": { medianLog1p: Math.log1p(0.005), madLog1p: 0.8 },
  "instagram:comment_ratio": { medianLog1p: Math.log1p(0.003), madLog1p: 0.8 },
  "tiktok:share_ratio": { medianLog1p: Math.log1p(0.01), madLog1p: 0.8 },
  "instagram:share_ratio": { medianLog1p: Math.log1p(0.002), madLog1p: 0.8 },
};

// ---------------------------------------------------------------------------
// Score components (§16.3)
// ---------------------------------------------------------------------------

export const FRESHNESS_HALF_LIFE_HOURS = 18;

export const ENGAGEMENT_RATIO_WEIGHTS = {
  like: 0.2,
  comment: 0.35,
  share: 0.45,
} as const;

/** Estimated-velocity shrink-toward-neutral (§16.3's V row): a lifetime
 * average overstates the CURRENT speed of an older post. */
export const ESTIMATED_VELOCITY_SHRINK = {
  /** k = clamp(1 - age_h/maxAgeForFullShrink, kMin, kMax) */
  maxAgeForFullShrinkHours: 48,
  kMin: 0.3,
  kMax: 1,
} as const;

export interface ScoreWeights {
  velocity: number;
  reach: number;
  engagement: number;
  freshness: number;
  hashtagMomentum: number;
  acceleration: number;
}

export const TREND_SCORE_WEIGHTS: ScoreWeights = {
  velocity: 0.35,
  reach: 0.2,
  engagement: 0.15,
  freshness: 0.15,
  hashtagMomentum: 0.1,
  acceleration: 0.05,
};

export const RISING_SCORE_WEIGHTS: ScoreWeights = {
  velocity: 0.5,
  reach: 0,
  engagement: 0.1,
  freshness: 0.2,
  hashtagMomentum: 0,
  acceleration: 0.2,
};

// ---------------------------------------------------------------------------
// Hashtag trend algorithm (§17)
// ---------------------------------------------------------------------------

export const HASHTAG_TREND_CONFIG = {
  /** Smoothing prior in g = log2((v24+prior)/(b7+prior)) — stops 0->1
   * reading as infinite growth. */
  smoothingPrior: 2,
  minHistoryDaysForNonNew: 2,
  breakout: { minV24: 3, minC24: 3, minG: 1.3 },
  rising: { minV24: 2, minC24: 2, minG: 0.5 },
  falling: { minB7: 1.5, maxG: -0.6 },
  active: { minV24: 2 },
  stable: { minV24: 1, minW24: 3 },
  deadWindowHours: 72,
} as const;

/** momentum = sigmoid(g) * (1 - e^(-v24/shrinkRate)) — the second factor
 * is the small-sample shrinkage: a single viral post (v24=1) contributes
 * far less confidence than a sustained run of them. */
export const HASHTAG_MOMENTUM_SHRINK_RATE = 2;

// ---------------------------------------------------------------------------
// Hashtag momentum component on posts (§23 of the Phase 6 brief)
// ---------------------------------------------------------------------------

export const POST_HASHTAG_MOMENTUM_TOP_K = 3;

// ---------------------------------------------------------------------------
// Co-occurrence (§34-35)
// ---------------------------------------------------------------------------

export const COOCCURRENCE_CONFIG = {
  /** Cap on how many non-generic tags of one post participate in pair
   * generation — bounds C(n,2) from a pathological 100-tag post. */
  maxTagsPerPost: 10,
  /** Candidate-generation evidence bar (§36, mirrors IMPLEMENTATION_PLAN
   * §11's "candidate generation" rule): an untracked tag co-occurring
   * with a tracked CORE/ACTIVE tag needs this many qualified posts by
   * this many distinct creators within this window to become a
   * candidate. */
  candidateWindowHours: 48,
  candidateMinQualifiedPosts: 2,
  candidateMinDistinctCreators: 2,
} as const;

// ---------------------------------------------------------------------------
// Post trend state (§28 of the Phase 6 brief — a NEW post-level concept,
// distinct from tracking tier and from the hashtag trend-state formula
// above; thresholds expressed in terms of already-computed score
// components so this file stays the single source of tunables).
// ---------------------------------------------------------------------------

export const POST_TREND_STATE_CONFIG = {
  /** BREAKOUT: young + unusually high velocity/rising signal — the same
   * "young" window as EARLY_BREAKOUT's own qualification (thresholds.ts),
   * not the looser 24h "same day" window, so a merely-strong 12h-old
   * post (still a real RISING candidate) doesn't get lumped in with a
   * genuinely brand-new breakout. */
  breakout: { maxAgeHours: 8, minRisingScore: 70 },
  /** RISING: positive, meaningful current growth. */
  rising: { minRisingScore: 45 },
  /** ACTIVE: performing strongly, not necessarily accelerating. */
  active: { minTrendScore: 45 },
  /** STABLE: modest continued growth. */
  stable: { minTrendScore: 20 },
  /** FALLING: material slowdown after stronger prior performance —
   * negative acceleration below this threshold (on the -1..1-ish log2
   * ratio scale, pre-sigmoid) while still otherwise active. */
  fallingAccelerationCeiling: -0.5,
  /** DEAD: outside the useful window / negligible recent growth. */
  deadMaxVph: 50,
  /** Hysteresis: once in a state, require this many hours before a
   * "weaker" adjacent-state transition takes effect, to avoid flapping
   * across one threshold every analytics run. */
  hysteresisHours: 3,
} as const;

// ---------------------------------------------------------------------------
// Analytics-informed refresh priority (Phase 6 brief §45-47) — Phase 5's
// own eligibility gate (views/age/refresh-count in config/schedule.ts's
// REFRESH_CONFIG) is untouched; this only adjusts WHEN an already-
// eligible post's next refresh happens, through the same next_refresh_at
// column (brief §47's "clear boundary").
// ---------------------------------------------------------------------------

export const REFRESH_PRIORITY_CONFIG = {
  /** BREAKOUT/RISING posts get bumped to refresh this soon instead of the
   * default step — spend budget where another snapshot most improves
   * detection. */
  prioritizedDelayHours: 2,
  /** Trend states past which a paid refresh stops being worth it — Phase
   * 6 clears next_refresh_at entirely for these (Phase 5's own gate would
   * likely exclude them anyway via views/age, but this is explicit rather
   * than relying on that as a side effect). */
  deprioritizeStates: ["DEAD", "FALLING"] as const,
} as const;
