/**
 * Pure discovery-tag selection/interval logic (Phase 5 brief §8-9). The DB
 * query that fetches candidate rows lives in
 * src/db/repositories/tracking.ts; this module only decides, given already
 * -fetched due candidates, which ones fill a batch, and given a row's
 * tier/source/trend_state, how far out its next discovery is due.
 *
 * Does NOT change tiers or implement promotion/demotion (Phase 6).
 */
import { assertNever } from "@/lib/exhaustive.ts";
import { TIER_DISCOVERY_INTERVAL_HOURS } from "@/config/schedule.ts";
import type { HashtagSource, TrackingTier, TrendState } from "@/core/domain/tracking.ts";

export type { HashtagSource, TrackingTier, TrendState } from "@/core/domain/tracking.ts";

export interface DueHashtagCandidate {
  trackedHashtagId: number;
  hashtagId: number;
  hashtagName: string;
  tier: TrackingTier;
  source: HashtagSource;
  trendState: TrendState;
  nextDueAt: Date | null;
}

/** Hours until this row's tier/source/trend_state combination is next due
 * for discovery. CORE tightens from 48h to 24h while trend_state is
 * BREAKOUT/RISING — trend_state is a read-only, already-persisted field
 * here (Phase 3), never computed by this function (that's Phase 6). */
export function tierDiscoveryIntervalHours(tier: TrackingTier, source: HashtagSource, trendState: TrendState): number {
  switch (tier) {
    case "CORE":
      return trendState === "BREAKOUT" || trendState === "RISING"
        ? TIER_DISCOVERY_INTERVAL_HOURS.CORE_TIGHTENED
        : TIER_DISCOVERY_INTERVAL_HOURS.CORE;
    case "ACTIVE":
      return TIER_DISCOVERY_INTERVAL_HOURS.ACTIVE;
    case "EXPLORATION":
      return TIER_DISCOVERY_INTERVAL_HOURS.EXPLORATION;
    case "DORMANT":
      return source === "SEED" ? TIER_DISCOVERY_INTERVAL_HOURS.DORMANT_SEED : TIER_DISCOVERY_INTERVAL_HOURS.DORMANT_DISCOVERED;
    default:
      return assertNever(tier, "tierDiscoveryIntervalHours");
  }
}

export function computeNextDueAt(tier: TrackingTier, source: HashtagSource, trendState: TrendState, now: Date): Date {
  const hours = tierDiscoveryIntervalHours(tier, source, trendState);
  return new Date(now.getTime() + hours * 3_600_000);
}

/**
 * Selects up to `batchSize` due candidates for one discovery job, ordered
 * CORE first, then ACTIVE, then EXPLORATION/DORMANT — each group already
 * sorted oldest-due-first by the caller's DB query. Taking a flat top-N
 * slice (rather than enforcing rigid per-tier buckets) is what implements
 * §10's "unused reservations roll over to the next class": if CORE has
 * fewer due rows than its reservation, the slice naturally reaches further
 * into ACTIVE/EXPLORATION to fill the batch.
 */
export function selectHashtagsForDiscovery(
  candidatesByTier: {
    core: DueHashtagCandidate[];
    active: DueHashtagCandidate[];
    explorationOrDormant: DueHashtagCandidate[];
  },
  batchSize: number,
): DueHashtagCandidate[] {
  return [...candidatesByTier.core, ...candidatesByTier.active, ...candidatesByTier.explorationOrDormant].slice(
    0,
    batchSize,
  );
}
