/**
 * Acceleration (Phase 6 brief §12, plan §16.3's A component): whether
 * growth is speeding up or slowing down. Only meaningful when velocity
 * has HIGH confidence (>= 2 real observed intervals) — anything else
 * returns `null`, never a fabricated 0 (CLAUDE.md rule 8).
 */
import type { VelocityConfidence } from "./velocity.ts";

const CLAMP_MIN = -5;
const CLAMP_MAX = 5;

/** log2(current/previous): 2x -> +1, flat -> 0, halved -> -1. Clamped to
 * keep a since-zero or near-zero previous interval from producing
 * +/-Infinity downstream. */
export function computeAcceleration(vphCurrent: number | null, vphPrevious: number | null, confidence: VelocityConfidence): number | null {
  if (confidence !== "HIGH") return null;
  if (vphCurrent === null || vphPrevious === null) return null;
  if (vphPrevious <= 0) return null; // no meaningful ratio against a zero/negative baseline
  const current = Math.max(0, vphCurrent);
  if (current === 0) return CLAMP_MIN; // growth stopped entirely — a real, informative floor, not "unknown"
  const ratio = Math.log2(current / vphPrevious);
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, ratio));
}
