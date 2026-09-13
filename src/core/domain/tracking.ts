/**
 * Shared hashtag-tracking vocabulary. Split out so both
 * core/scheduling/tag-selector.ts (Phase 5) and core/analytics/*,
 * core/lifecycle/* (Phase 6) reference the SAME types instead of
 * redeclaring them — `trendStateEnum` in db/schema.ts is one Postgres
 * enum shared by trackedHashtags, hashtagDailyStats, and (Phase 6) posts.
 *
 * Two concepts, never merged (CLAUDE.md rule 13 / Phase 6 brief §33):
 *   - TrackingTier: how much crawl budget a tag gets.
 *   - TrendState: what's happening to it (or, for a post, to itself)
 *     right now.
 */
export const TRACKING_TIERS = ["CORE", "ACTIVE", "EXPLORATION", "DORMANT"] as const;
export type TrackingTier = (typeof TRACKING_TIERS)[number];

export const HASHTAG_SOURCES = ["SEED", "DISCOVERED", "MANUAL"] as const;
export type HashtagSource = (typeof HASHTAG_SOURCES)[number];

export const TREND_STATES = ["BREAKOUT", "RISING", "ACTIVE", "STABLE", "FALLING", "DEAD", "NEW"] as const;
export type TrendState = (typeof TREND_STATES)[number];
