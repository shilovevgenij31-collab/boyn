/**
 * Deterministic trend states (Phase 6 brief §28-29, §33, plan §17) — two
 * SEPARATE concepts sharing one enum type (schema.ts's `trend_state`):
 *   - post trend state: what a single post is doing right now.
 *   - hashtag trend state: momentum inside our monitored sample (never a
 *     tracking-tier substitute — CLAUDE.md rule 13 / brief §33).
 * Both include simple hysteresis (brief §29) so a value hovering near one
 * threshold doesn't flap every analytics run.
 */
import { HASHTAG_TREND_CONFIG, POST_TREND_STATE_CONFIG } from "@/config/scoring.ts";
import type { TrendState } from "@/core/domain/tracking.ts";

export type { TrendState } from "@/core/domain/tracking.ts";

export interface HashtagTrendStateInput {
  v24: number;
  c24: number;
  w24: number;
  b7: number;
  g: number;
  historyDays: number;
}

/** Evaluated in the plan §17 table's exact order — first match wins,
 * except NEW's explicit override ("a NEW tag can still be reported as
 * breakout when v24>=3 and c24>=3"). */
export function deriveHashtagTrendState(input: HashtagTrendStateInput): TrendState {
  const cfg = HASHTAG_TREND_CONFIG;
  const clearsBreakoutBar = input.v24 >= cfg.breakout.minV24 && input.c24 >= cfg.breakout.minC24 && input.g >= cfg.breakout.minG;

  if (input.historyDays < cfg.minHistoryDaysForNonNew && !clearsBreakoutBar) return "NEW";
  if (clearsBreakoutBar) return "BREAKOUT";
  if (input.v24 >= cfg.rising.minV24 && input.c24 >= cfg.rising.minC24 && input.g >= cfg.rising.minG) return "RISING";
  if (input.b7 >= cfg.falling.minB7 && input.g <= cfg.falling.maxG) return "FALLING";
  if (input.v24 >= cfg.active.minV24) return "ACTIVE";
  if (input.v24 >= cfg.stable.minV24 || input.w24 >= cfg.stable.minW24) return "STABLE";
  return "DEAD";
}

export interface PostTrendStateInput {
  ageHours: number;
  trendScore: number | null;
  risingScore: number | null;
  acceleration: number | null;
  vph: number | null;
}

/**
 * Semantics (brief §28): BREAKOUT = young + unusually high rising signal;
 * RISING = positive meaningful current growth; FALLING = material
 * slowdown after stronger prior performance; ACTIVE = performing
 * strongly, not necessarily accelerating; STABLE = modest continued
 * growth; DEAD = negligible recent growth, outside the useful window.
 * Never derived from TrendScore alone (brief §28) — RisingScore and
 * acceleration each get their own say.
 */
export function derivePostTrendState(input: PostTrendStateInput): TrendState {
  const cfg = POST_TREND_STATE_CONFIG;
  const trendScore = input.trendScore ?? 0;
  const risingScore = input.risingScore ?? 0;

  if (input.ageHours <= cfg.breakout.maxAgeHours && risingScore >= cfg.breakout.minRisingScore) return "BREAKOUT";
  if (risingScore >= cfg.rising.minRisingScore) return "RISING";
  // Checked before the generic TrendScore buckets below: a post outside
  // the useful window with negligible CURRENT velocity is dead regardless
  // of how much historical reach is inflating its TrendScore via the
  // reach component — reach reflects the past, not "is this still
  // happening" (brief §28's DEAD semantics).
  if (input.ageHours > 72 && (input.vph ?? 0) <= cfg.deadMaxVph) return "DEAD";
  if (input.acceleration !== null && input.acceleration <= cfg.fallingAccelerationCeiling && trendScore >= cfg.stable.minTrendScore) return "FALLING";
  if (trendScore >= cfg.active.minTrendScore) return "ACTIVE";
  if (trendScore >= cfg.stable.minTrendScore) return "STABLE";
  return "STABLE";
}

const STATE_RANK: Record<TrendState, number> = { DEAD: 0, NEW: 1, STABLE: 1, FALLING: 1, ACTIVE: 2, RISING: 3, BREAKOUT: 4 };

export interface PreviousTrendState {
  state: TrendState;
  since: Date;
}

/**
 * Hysteresis (brief §29): an upgrade (moving to a "higher energy" state)
 * always applies immediately — good news should surface fast. A downgrade
 * within `hysteresisHours` of the last real change is suppressed (holds
 * the previous state) unless enough time has passed. Deliberately simple
 * — not a probabilistic state machine.
 */
export function applyTrendStateHysteresis(
  previous: PreviousTrendState | null,
  candidate: TrendState,
  now: Date,
  hysteresisHours: number,
): TrendState {
  if (!previous || candidate === previous.state) return candidate;
  const elapsedHours = (now.getTime() - previous.since.getTime()) / 3_600_000;
  if (elapsedHours >= hysteresisHours) return candidate;
  return STATE_RANK[candidate] >= STATE_RANK[previous.state] ? candidate : previous.state;
}
