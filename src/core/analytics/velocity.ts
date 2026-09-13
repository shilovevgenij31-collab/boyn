/**
 * Observed vs. estimated views-per-hour (Phase 6 brief §7-11, plan §16.1).
 * Pure function over an already-fetched snapshot history — no DB access,
 * no Date.now() (an explicit `now` is always passed in, per CLAUDE.md
 * rule 3).
 *
 * Deterministic rule (golden-tested, see test/unit/core-analytics-
 * velocity.test.ts): publication is treated as a virtual (publishedAt, 0
 * views) snapshot. Consecutive points are merged forward until the gap
 * between them is >= NOISE_GUARDS.minObservedIntervalHours, which is what
 * "prefer recent observations that reflect CURRENT velocity" (brief §8)
 * actually means here — the merge walk naturally lands on the newest
 * valid pair whose gap is wide enough to be trustworthy, not an arbitrary
 * first/last pair. The LAST such interval is `vphCurrent`; the one before
 * it (if any) is `vphPrevious`, used by acceleration.ts.
 */
import { NOISE_GUARDS } from "@/config/thresholds.ts";

export type VelocityKind = "OBSERVED" | "ESTIMATED" | "NONE";
export type VelocityConfidence = "HIGH" | "MEDIUM" | "LOW" | null;

export interface VelocitySnapshot {
  observedAt: Date;
  views: number | null;
}

export interface VelocityResult {
  kind: VelocityKind;
  /** Views per hour, current interval. `null` only when kind === "NONE". */
  vph: number | null;
  /** The interval before `vph`'s — only present for OBSERVED with >= 2
   * real (non-birth) intervals. Feeds acceleration.ts. */
  vphPrevious: number | null;
  confidence: VelocityConfidence;
  /** A provider reported fewer views than a strictly earlier observation
   * (Phase 6 brief §7's "provider count regressions") — the delta was
   * floored to 0, never allowed to go negative, but this flag lets a
   * caller note the data-quality anomaly (plan §15). */
  hadNegativeDeltaAnomaly: boolean;
}

interface Point {
  t: Date;
  views: number;
  isBirth: boolean;
}

interface MergedInterval {
  elapsedHours: number;
  deltaViews: number;
  fromIsBirth: boolean;
  hadNegativeDelta: boolean;
}

const NONE_RESULT: VelocityResult = { kind: "NONE", vph: null, vphPrevious: null, confidence: null, hadNegativeDeltaAnomaly: false };

function buildMergedIntervals(points: Point[], minIntervalHours: number): MergedInterval[] {
  const intervals: MergedInterval[] = [];
  if (points.length === 0) return intervals;
  let anchor = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const elapsedHours = (p.t.getTime() - anchor.t.getTime()) / 3_600_000;
    if (elapsedHours < minIntervalHours) continue; // merged into the current anchor
    let deltaViews = p.views - anchor.views;
    let hadNegativeDelta = false;
    if (deltaViews < 0) {
      hadNegativeDelta = true;
      deltaViews = 0;
    }
    intervals.push({ elapsedHours, deltaViews, fromIsBirth: anchor.isBirth, hadNegativeDelta });
    anchor = p;
  }
  return intervals;
}

export function computeVelocity(params: { snapshots: VelocitySnapshot[]; publishedAt: Date | null; now: Date }): VelocityResult {
  const { publishedAt, now } = params;
  if (publishedAt === null) return NONE_RESULT;

  const validSnapshots = params.snapshots
    .filter((s): s is { observedAt: Date; views: number } => s.views !== null)
    .slice()
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  if (validSnapshots.length === 0) return NONE_RESULT;

  const points: Point[] = [
    { t: publishedAt, views: 0, isBirth: true },
    ...validSnapshots.map((s) => ({ t: s.observedAt, views: s.views, isBirth: false })),
  ];

  const intervals = buildMergedIntervals(points, NOISE_GUARDS.minObservedIntervalHours);
  const hadNegativeDeltaAnomaly = intervals.some((iv) => iv.hadNegativeDelta);
  const realIntervals = intervals.filter((iv) => !iv.fromIsBirth);

  if (realIntervals.length >= 1) {
    const current = realIntervals[realIntervals.length - 1]!;
    const previous = realIntervals.length >= 2 ? realIntervals[realIntervals.length - 2]! : null;
    return {
      kind: "OBSERVED",
      vph: current.deltaViews / current.elapsedHours,
      vphPrevious: previous ? previous.deltaViews / previous.elapsedHours : null,
      confidence: realIntervals.length >= 2 ? "HIGH" : "MEDIUM",
      hadNegativeDeltaAnomaly,
    };
  }

  if (intervals.length >= 1) {
    // Only the birth interval qualified (a single real snapshot far
    // enough past publication) — this is an estimate of the post's
    // lifetime-average rate, not a measured current rate.
    const birth = intervals[0]!;
    return {
      kind: "ESTIMATED",
      vph: birth.deltaViews / birth.elapsedHours,
      vphPrevious: null,
      confidence: "LOW",
      hadNegativeDeltaAnomaly,
    };
  }

  // No interval cleared the minimum gap at all (e.g. a brand-new post
  // with its only snapshot taken moments after publication) — fall back
  // to raw views/age, with an age floor so a 50K-view post at 10 minutes
  // old doesn't read as an absurd 300K/h (brief §10).
  const latest = validSnapshots[validSnapshots.length - 1]!;
  const ageHours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  const denominator = Math.max(ageHours, NOISE_GUARDS.minEstimationAgeHours);
  return {
    kind: "ESTIMATED",
    vph: latest.views / denominator,
    vphPrevious: null,
    confidence: "LOW",
    hadNegativeDeltaAnomaly,
  };
}
