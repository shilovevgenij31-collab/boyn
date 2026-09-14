/**
 * Daily report tunables (Phase 7). Keeps every bound/threshold out of
 * core/report/* so the algorithms stay parameterized and testable
 * (CLAUDE.md rule 7 — no scattered magic numbers).
 *
 * Today/Still-Hot window rule (Phase 7 brief §1 — supersedes the older
 * "<=72h in Today" plan wording): Today is a STRICT last-24h window;
 * Still Hot is the next 48h (24-72h before window end). These are
 * half-open boundaries — see core/report/build-daily-report.ts's module
 * comment for the exact inclusive/exclusive convention.
 */

export const REPORT_WINDOW_HOURS = {
  today: 24,
  stillHotOuter: 72,
} as const;

export const TODAY_TOP_CONFIG = {
  max: 30,
  maxPerCreator: 2,
  /** Each platform gets at least min(available eligible, this) slots —
   * a floor, never a padding quota (Phase 7 brief §13). */
  platformFloor: 8,
} as const;

/** Plan §19's already-approved value (15), not the brief's fallback
 * default of 10 — an existing accepted config value takes precedence
 * per the brief's own instruction (§15). */
export const STILL_HOT_MAX = 15;

export const RISING_NOW_MAX = 10;

export const EXPORT_CANDIDATES_MAX = 100;

export const HASHTAG_SECTION_MAX = 10;

export const CLUSTER_CONFIG = {
  max: 10,
  minViralPosts: 2,
  minJaccard: 0.15,
  maxTagsPerCluster: 8,
} as const;

/** Bounded caption preview stored in a frozen ReportItem — not the full
 * provider caption text (Phase 7 brief §68). */
export const CAPTION_PREVIEW_MAX_CHARS = 300;
