/**
 * Hashtag Radar Momentum (Phase 6 brief §31-33, plan §17). Wording note
 * (ADR-022, CLAUDE.md rule 13): this is growth inside our own bounded,
 * budgeted sample of tracked tags — NEVER phrased as a platform-wide
 * claim. Field/function names stay plain ("growth", "momentum"); it's the
 * user-facing copy built from them (Phase 7+) that must say "Radar
 * momentum" / "observed in our monitored sample".
 */
import { sigmoid } from "./baselines.ts";
import { HASHTAG_MOMENTUM_SHRINK_RATE, HASHTAG_TREND_CONFIG } from "@/config/scoring.ts";
import { POST_HASHTAG_MOMENTUM_TOP_K } from "@/config/scoring.ts";

/** Smoothed growth: log2((v24+prior)/(b7+prior)). The +prior stops a
 * 0 -> 1 change from reading as infinite growth. */
export function computeHashtagGrowth(v24: number, b7: number): number {
  const prior = HASHTAG_TREND_CONFIG.smoothingPrior;
  return Math.log2((v24 + prior) / (b7 + prior));
}

/**
 * momentum = sigmoid(g) * (1 - e^(-v24/shrinkRate)) — the second factor
 * is deliberate small-sample shrinkage (brief §32): a single qualified
 * post (v24=1) contributes far less confidence than a sustained run, so
 * a spam-heavy tag with one lucky viral post doesn't read as "hot".
 */
export function computeHashtagMomentum(g: number, v24: number): number {
  const shrink = 1 - Math.exp(-v24 / HASHTAG_MOMENTUM_SHRINK_RATE);
  return sigmoid(g) * shrink;
}

/**
 * Post-level hashtag-momentum component (brief §23): the mean of the
 * post's top-K non-generic tags' own momentum, so a handful of strong
 * tags can lift a post but dozens of spam tags can't multiply the score.
 * Tags with no known momentum (untracked / not yet computed) are simply
 * excluded, never treated as 0 — a post with zero known-momentum tags
 * returns `null` (CLAUDE.md rule 8).
 */
export function computePostHashtagMomentum(tagMomentums: (number | null)[]): number | null {
  const known = tagMomentums.filter((m): m is number => m !== null);
  if (known.length === 0) return null;
  const top = [...known].sort((a, b) => b - a).slice(0, POST_HASHTAG_MOMENTUM_TOP_K);
  return top.reduce((sum, x) => sum + x, 0) / top.length;
}
