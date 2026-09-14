/**
 * Retention policy (Phase 7 brief §44, plan §24) — one typed source for
 * every TTL, so jobs/retention.ts never scatters a raw day count.
 * Anchored on each row's own natural "when did this happen" timestamp
 * (never inferred, never approximated from unrelated fields — brief §45).
 */

/** Post retention depends on its LAST qualification tier — an unknown
 * (null) tier is deliberately treated as the most conservative (longest)
 * bucket, never aggressively deleted (brief §45). */
export const POST_RETENTION_DAYS = {
  NOISE: 14,
  WATCH: 30,
  VIRAL_QUALIFIED: 180,
  EARLY_BREAKOUT: 180,
  UNKNOWN: 180,
} as const;

export const RETENTION_DAYS = {
  postSnapshots: 90,
  postDiscoveries: 30,
  hashtagCooccurrenceDaily: 60,
  hashtagDailyStats: 365,
  dailyReports: 365,
  collectionRunsAndProviderJobs: 90,
  resultViews: 14,
  quarantinedItems: 14,
  telegramUpdates: 7,
  errorEvents: 30,
} as const;

/** Dead-man threshold (Phase 7 brief §55, plan's "> 90 min" figure). */
export const DEAD_MAN_THRESHOLD_MINUTES = 90;
