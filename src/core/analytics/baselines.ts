/**
 * Robust statistics primitives (Phase 6 brief §15-17): median, MAD, and a
 * robust z-score on a log-transformed scale, plus the logistic squash
 * that turns an unbounded z into a comparable 0..1 component. Pure,
 * deterministic, no I/O — the baseline VALUES themselves (computed from
 * real recent data, or the seeded defaults) come from
 * core/analytics/scoring.ts's caller, not from here.
 */
import { BASELINE_CONFIG } from "@/config/scoring.ts";

export function median(sortedOrUnsorted: number[]): number {
  if (sortedOrUnsorted.length === 0) return 0;
  const xs = [...sortedOrUnsorted].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
}

/** Median Absolute Deviation — robust spread measure, insensitive to the
 * heavy tails viral data produces. */
export function mad(xs: number[], centerMedian?: number): number {
  if (xs.length === 0) return 0;
  const m = centerMedian ?? median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export function log1p(x: number): number {
  return Math.log1p(Math.max(0, x));
}

export interface RobustBaseline {
  medianLog1p: number;
  madLog1p: number;
  n: number;
}

export function computeRobustBaseline(rawValues: number[]): RobustBaseline {
  const logs = rawValues.map(log1p);
  return { medianLog1p: median(logs), madLog1p: mad(logs), n: rawValues.length };
}

/**
 * Robust z-score on the log scale: `(ln(1+x) - median) / (1.4826*MAD)`,
 * clipped asymmetrically (upside outliers matter more than downside —
 * §16.2). Defensive against MAD=0 (a degenerate/tiny sample where every
 * observation is identical) by falling back to a z of 0 rather than
 * producing Infinity/NaN.
 */
export function robustZ(rawValue: number, baseline: RobustBaseline): number {
  const x = log1p(rawValue);
  if (baseline.madLog1p <= 0) return 0;
  const z = (x - baseline.medianLog1p) / (1.4826 * baseline.madLog1p);
  return clamp(z, BASELINE_CONFIG.zClipMin, BASELINE_CONFIG.zClipMax);
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/** True once a baseline was computed from enough real observations to
 * trust over the seeded default (config/scoring.ts's BASELINE_CONFIG
 * .minSampleSize) — callers use this to decide which baseline to apply. */
export function isBaselineReliable(n: number): boolean {
  return n >= BASELINE_CONFIG.minSampleSize;
}
