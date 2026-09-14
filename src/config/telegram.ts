/**
 * Telegram tunables (Phase 8 brief §7). Typed here rather than scattered
 * as magic numbers through src/telegram/* (CLAUDE.md rule 7).
 */

/** result_views TTL (brief §20) — matches config/retention.ts's
 * `resultViews` TTL exactly; kept as its own named constant here since
 * it's a Telegram-facing concept, not duplicated logic (retention.ts's
 * value stays the single source of truth for the actual sweep). */
export const RESULT_VIEW_TTL_DAYS = 14;

/** LIVE (current-state) view pools are bounded, not "every qualifying
 * post ever" — comfortably larger than one page (5) so pagination has
 * real depth, without loading an unbounded ranking into memory/JSON. */
export const LIVE_VIEW_MAX_ITEMS = 30;

/** Durable per-command cooldowns (app_settings-backed), brief §47/§50. */
export const EXPORT_COOLDOWN_MINUTES = 5;
export const REFRESH_COOLDOWN_MINUTES = 30;

/** `/rising`'s own freshness bar (brief §36) — reuses Phase 6's rankable
 * pool, this only bounds how old a LIVE rising candidate may be. */
export const RISING_MAX_AGE_HOURS = 24;
