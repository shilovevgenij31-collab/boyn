/**
 * Collection schedule (Phase 5) — LEAN defaults from
 * docs/IMPLEMENTATION_PLAN.md §11-§14, made concrete and typed rather than
 * scattered as magic numbers through src/jobs/* and src/core/scheduling/*
 * (CLAUDE.md rule 7).
 *
 * Slot times/allocations/intervals below are the plan's locked LEAN
 * numbers, not invented ones. Where the plan left something unspecified
 * (poll cadence, lease duration, per-tick work limits — all operational,
 * not product, decisions), this file states an explicit conservative MVP
 * default and says so.
 */

// ---------------------------------------------------------------------------
// Slot boundaries (§12) — all UTC, sorted ascending.
// ---------------------------------------------------------------------------

export const DISCOVERY_SLOT_HOURS_UTC = [5, 13, 21] as const;
export const REFRESH_SLOT_HOURS_UTC = [1, 9, 17] as const;

// ---------------------------------------------------------------------------
// Discovery batching (§10, §12)
// ---------------------------------------------------------------------------

/** How many due tag-queries to select per discovery slot, per platform.
 * §12: "3 for CORE ... 2 for ACTIVE ... 1 for EXPLORATION/DORMANT probes."
 * Unused per-tier reservations roll over — see
 * core/scheduling/tag-selector.ts's selectHashtagsForDiscovery, which
 * implements the rollover by taking the top N from a tier-priority-ordered
 * list rather than enforcing hard per-tier buckets. */
export const DISCOVERY_SLOT_ALLOCATION = { core: 3, active: 2, explorationOrDormant: 1 } as const;
export const DISCOVERY_QUERIES_PER_SLOT =
  DISCOVERY_SLOT_ALLOCATION.core + DISCOVERY_SLOT_ALLOCATION.active + DISCOVERY_SLOT_ALLOCATION.explorationOrDormant;

/** §12: "6 tag-queries × 15 newest posts" (LEAN). */
export const POSTS_PER_DISCOVERY_QUERY = 15;

/** §12: "≤ 20 posts per run (collect by URL)" (LEAN). */
export const REFRESH_MAX_POSTS_PER_RUN = 20;

/** Maximum queries batched into a single provider job. All three adapters
 * were verified against small batches only (Phase 1/1B); capped at the
 * full per-slot allocation so one discovery slot -> one job per platform. */
export const DISCOVERY_BATCH_SIZE_PER_JOB = DISCOVERY_QUERIES_PER_SLOT;

// ---------------------------------------------------------------------------
// Tracking-tier discovery interval (§11 diagram, §12 slot-allocation prose)
// ---------------------------------------------------------------------------

export const TIER_DISCOVERY_INTERVAL_HOURS = {
  /** 48h normally; tightens to 24h while trend_state is BREAKOUT/RISING —
   * that field is already persisted (Phase 3) and read-only here, not
   * computed — computing it is Phase 6 lifecycle/analytics work. */
  CORE: 48,
  CORE_TIGHTENED: 24,
  ACTIVE: 24,
  EXPLORATION: 24,
  /** Seed tags parked DORMANT get a weekly probe; tags DEMOTED to DORMANT
   * (a Phase 6 concept — never happens yet) would get 14d, kept here for
   * when that exists. Phase 5 only ever sees SEED-sourced DORMANT rows. */
  DORMANT_SEED: 24 * 7,
  DORMANT_DISCOVERED: 24 * 14,
} as const;

// ---------------------------------------------------------------------------
// Refresh eligibility (§14, §28-31) — a conservative MVP subset only; the
// full staged/decayed-vph logic is Phase 6.
// ---------------------------------------------------------------------------

export const REFRESH_CONFIG = {
  /** Don't schedule a paid refresh for a post older than this at plan time. */
  maxAgeHours: 48,
  /** Only posts already showing some traction are worth a second look. */
  minViews: 5_000,
  /** §14: "stop ... paid_refresh_count = 3". */
  maxPaidRefreshCount: 3,
  /** First refresh at discovery+6h (§14's EARLY_BREAKOUT/VIRAL_QUALIFIED
   * rows target +3h/+6h; 6h is the conservative single-stage MVP choice
   * covering both without Phase 6 tier logic). Each subsequent refresh
   * adds the same conservative step again. */
  refreshStepHours: 6,
} as const;

// ---------------------------------------------------------------------------
// Provider polling (§20-21) — not locked in the plan; explicit MVP choice.
// Apify TikTok/Instagram discovery measured ~1-3 min to SUCCEEDED (Phase 4
// smoke); Bright Data measured 4-6 min (Phase 1B). Ticks fire ~30 min apart
// regardless, so these only matter for same-tick-window polling headroom
// and the offline simulation's faster clock.
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = {
  apify: 90_000,
  brightdata: 180_000,
} as const;

/** A job stuck past this long without reaching READY/FAILED is marked
 * TIMED_OUT (§20's "don't treat a long Bright Data job as failed merely
 * because it's still running" — but an unbounded wait isn't safe either).
 * Must be comfortably LARGER than the ~30 min external cron cadence
 * (§21/§42): a job submitted mid-tick gets its first poll opportunity on
 * the NEXT tick, up to ~30 min later, so a max-running budget shorter
 * than that would time out every job before it was ever polled even
 * once — sized here for several poll opportunities even if a tick or two
 * is delayed, well beyond each provider's measured latency (Apify ~1-3
 * min, Bright Data ~4-6 min). */
export const JOB_MAX_RUNNING_MS = {
  apify: 90 * 60_000,
  brightdata: 120 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Leases (§14-15) — not locked in the plan; explicit MVP choice. Long
// enough to cover one tick's worth of work on a single job, short enough
// that a crashed worker's lease clears well before the next ~30 min tick.
// ---------------------------------------------------------------------------

export const JOB_LEASE_MS = 5 * 60_000;

/** A run whose only job(s) so far all FAILED/TIMED_OUT gets one more
 * planning attempt in the same run (e.g. retrying via a now-available
 * fallback provider) before being left to finalize as FAILED — this is
 * what makes a genuine mixed-outcome PARTIAL run possible (Phase 5 brief
 * §32-34), rather than every failure being a guaranteed dead end. Bounded
 * so a persistently broken provider can't grow a run's job list forever. */
export const MAX_JOB_ATTEMPTS_PER_RUN = 2;

// ---------------------------------------------------------------------------
// Per-tick work limits (§47) — bounds one tick's work so it always exits
// quickly; sized around the LEAN §12 numbers (6 discovery queries/slot,
// ~20 provider jobs/day per §13).
// ---------------------------------------------------------------------------

export const TICK_LIMITS = {
  maxSubmissions: 6,
  maxPolls: 20,
  maxIngestions: 10,
} as const;

/** §5: a tick must never assume unlimited runtime. Vercel Hobby hard-kills
 * at 300s; this stays comfortably under that. Configurable via
 * TICK_DEADLINE_MS env override if the deploy needs a different budget. */
export const DEFAULT_TICK_DEADLINE_MS = 45_000;
