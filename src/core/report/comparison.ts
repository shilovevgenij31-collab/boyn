/**
 * Yesterday comparison (Phase 7 brief §25): deltas for headline metrics
 * against the previous frozen report. No previous report means `null`
 * deltas — never a fabricated 0%/0 (CLAUDE.md rule 8's "missing != zero"
 * applies here too).
 */
import type { MetricDelta } from "./types.ts";

export function computeDelta(current: number, previous: number | null): MetricDelta {
  return { current, previous, delta: previous === null ? null : current - previous };
}
