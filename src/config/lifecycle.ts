/**
 * Hashtag tracking-tier lifecycle rules (Phase 6), from
 * docs/IMPLEMENTATION_PLAN.md §11. Governs CORE/ACTIVE/EXPLORATION/
 * DORMANT tier transitions — NOT trend state (config/scoring.ts's
 * HASHTAG_TREND_CONFIG), a separate concept (CLAUDE.md / Phase 6 brief
 * §33: never merge tracking tier with trend state).
 *
 * Deliberately conservative and bounded: the crawl budget depends on tier
 * caps, so promotion requires real, repeated evidence — never a single
 * viral video — and CORE (config seeds) is never auto-demoted.
 */

export const TIER_CAPS = {
  exploration: 8,
  active: 6,
  /** Per platform/market, per day. */
  maxNewExplorationPerDay: 3,
} as const;

/** Minimum time between two tier changes on the SAME tracked_hashtags
 * row — prevents a tag flapping tiers across consecutive analytics runs. */
export const TIER_CHANGE_HYSTERESIS_HOURS = 24;

/** Untracked-tag candidate generation (§11's diagram: "candidate
 * generation"). Matches COOCCURRENCE_CONFIG's candidate.* thresholds in
 * config/scoring.ts, restated here as the lifecycle-facing view of the
 * same evidence bar (an untracked tag becomes a brand-new EXPLORATION
 * row, not a "promotion" of an existing one). */
export const CANDIDATE_GENERATION = {
  windowHours: 48,
  minQualifiedPosts: 2,
  minDistinctCreators: 2,
  minHashtagLength: 3,
} as const;

/** EXPLORATION -> ACTIVE (§11: "probes yield >=2 viral/breakout posts
 * from >=2 creators, OR trend_state in {BREAKOUT, RISING}"). */
export const EXPLORATION_PROMOTION = {
  minQualifiedPosts: 2,
  minDistinctCreators: 2,
  promoteOnTrendStates: ["BREAKOUT", "RISING"] as const,
};

/** EXPLORATION -> DORMANT (§11: "2 probes / 4 days, criteria not met"). */
export const EXPLORATION_DEMOTION = {
  minProbes: 2,
  windowDays: 4,
};

/** ACTIVE -> DORMANT (§11's diagram: "state FALLING/DEAD x2 evals, or 3
 * scans with 0 viral, or evicted by a stronger tag"). Automatic demotion
 * NEVER applies to CORE (config seeds) — see the module doc comment. */
export const ACTIVE_DEMOTION = {
  consecutiveWeakTrendStateEvals: 2,
  weakTrendStates: ["FALLING", "DEAD"] as const,
  consecutiveZeroViralScans: 3,
};

/** DORMANT -> EXPLORATION passive revival (§11: ">=3 viral posts seen via
 * other tags in 48h"). */
export const PASSIVE_REVIVAL = {
  windowHours: 48,
  minViralPostsViaOtherTags: 3,
};
