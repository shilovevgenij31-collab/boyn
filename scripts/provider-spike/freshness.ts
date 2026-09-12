/**
 * Freshness statistics over a sample of posts. Pure, deterministic (given a
 * `now`), and the main empirical output of Phase 1 — see
 * docs/IMPLEMENTATION_PLAN.md "Phase 1 — Provider spike" in the amended
 * plan and docs/PROVIDER_SPIKE.md.
 *
 * A missing/unparseable publish timestamp is excluded from age statistics
 * (never coerced to a fake age) but counted in `withTimestamp` /
 * `sampleSize` so coverage is still visible.
 */

export interface FreshnessStats {
  sampleSize: number;
  withTimestamp: number;
  medianAgeHours: number | null;
  p25AgeHours: number | null;
  p75AgeHours: number | null;
  p90AgeHours: number | null;
  minAgeHours: number | null;
  maxAgeHours: number | null;
  pctLt6h: number | null;
  pctLt12h: number | null;
  pctLt24h: number | null;
  pctLt48h: number | null;
  pctLt72h: number | null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedAsc[lowerIndex]!;
  const upper = sortedAsc[upperIndex]!;
  if (lowerIndex === upperIndex) return lower;
  const frac = rank - lowerIndex;
  return lower + (upper - lower) * frac;
}

function pctBelow(sortedAsc: number[], thresholdHours: number): number {
  const count = sortedAsc.filter((h) => h < thresholdHours).length;
  return round1((count / sortedAsc.length) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * @param publishedAtByRecord One entry per record in the sample; `null` for
 *   a record with no parseable publish timestamp.
 * @param now Reference instant (inject for deterministic tests).
 */
export function computeFreshnessStats(
  publishedAtByRecord: readonly (Date | null)[],
  now: Date,
): FreshnessStats {
  const sampleSize = publishedAtByRecord.length;
  const ageHours = publishedAtByRecord
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .map((d) => (now.getTime() - d.getTime()) / (1000 * 60 * 60))
    // A "future" timestamp (clock skew / bad data) is not a valid age; drop it
    // rather than reporting a misleading negative age.
    .filter((h) => h >= 0);

  const withTimestamp = ageHours.length;

  if (withTimestamp === 0) {
    return {
      sampleSize,
      withTimestamp: 0,
      medianAgeHours: null,
      p25AgeHours: null,
      p75AgeHours: null,
      p90AgeHours: null,
      minAgeHours: null,
      maxAgeHours: null,
      pctLt6h: null,
      pctLt12h: null,
      pctLt24h: null,
      pctLt48h: null,
      pctLt72h: null,
    };
  }

  const sorted = [...ageHours].sort((a, b) => a - b);

  return {
    sampleSize,
    withTimestamp,
    medianAgeHours: round1(percentile(sorted, 50)),
    p25AgeHours: round1(percentile(sorted, 25)),
    p75AgeHours: round1(percentile(sorted, 75)),
    // p90 needs a reasonably sized sample to be meaningful.
    p90AgeHours: withTimestamp >= 5 ? round1(percentile(sorted, 90)) : null,
    minAgeHours: round1(sorted[0]!),
    maxAgeHours: round1(sorted[sorted.length - 1]!),
    pctLt6h: pctBelow(sorted, 6),
    pctLt12h: pctBelow(sorted, 12),
    pctLt24h: pctBelow(sorted, 24),
    pctLt48h: pctBelow(sorted, 48),
    pctLt72h: pctBelow(sorted, 72),
  };
}
