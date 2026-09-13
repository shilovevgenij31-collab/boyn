/**
 * Hashtag tracking-tier lifecycle decisions (Phase 6 brief §37-40, plan
 * §11). Pure: given a tag's current tier/source/timestamps and
 * pre-aggregated evidence, decides whether to promote, demote, or hold —
 * no DB access. The orchestrating job (jobs/run-analytics.ts) fetches
 * evidence, calls this, and persists the result (including a
 * hashtag_tier_events row only on an actual change — brief §39).
 *
 * CORE is a permanent strategic seed: never auto-demoted, never
 * auto-promoted-into either (the original plan's diagram only ever shows
 * CONFIG SEEDS starting CORE — promoting a tag INTO CORE requires a
 * human `/track` decision, out of scope here; see final report deviations).
 */
import type { HashtagSource, TrackingTier } from "@/core/domain/tracking.ts";
import type { TrendState } from "@/core/domain/tracking.ts";
import {
  ACTIVE_DEMOTION,
  EXPLORATION_DEMOTION,
  EXPLORATION_PROMOTION,
  PASSIVE_REVIVAL,
  TIER_CHANGE_HYSTERESIS_HOURS,
} from "@/config/lifecycle.ts";

export type TierTransitionAction = "promote" | "demote" | "hold";

export interface TierDecision {
  action: TierTransitionAction;
  toTier: TrackingTier;
  reason: string;
}

export interface HashtagLifecycleState {
  tier: TrackingTier;
  source: HashtagSource;
  /** `null` means never transitioned since creation — no hysteresis to
   * apply. */
  tierChangedAt: Date | null;
  /** How many discovery scans have happened while in the CURRENT tier. */
  probesInTier: number;
  daysInTier: number;
}

export interface LifecycleEvidence {
  /** Qualified (VIRAL_QUALIFIED/EARLY_BREAKOUT) posts observed while in
   * the current tier. */
  qualifiedPostsInTier: number;
  distinctCreatorsInTier: number;
  /** The tag's OWN current trend state (trend-state.ts) — a signal, never
   * the tier itself (CLAUDE.md rule 13). */
  trendState: TrendState;
  /** How many of the most recent consecutive evaluations landed on a
   * "weak" trend state (FALLING/DEAD). */
  consecutiveWeakTrendStateEvals: number;
  consecutiveEmptyScans: number;
  /** Qualified posts carrying this hashtag found via ANY discovery path
   * (not just while actively tracked) within PASSIVE_REVIVAL.windowHours
   * — the piggyback signal that can revive a DORMANT tag. */
  recentQualifiedPostsAnyPath: number;
}

function hysteresisElapsed(tierChangedAt: Date | null, now: Date): boolean {
  if (!tierChangedAt) return true;
  const elapsedHours = (now.getTime() - tierChangedAt.getTime()) / 3_600_000;
  return elapsedHours >= TIER_CHANGE_HYSTERESIS_HOURS;
}

const HOLD: TierDecision = { action: "hold", toTier: "DORMANT" /* ignored for hold */, reason: "no_change" };

/**
 * Decides ONE tag's own transition, ignoring pool caps — the caller
 * (jobs/run-analytics.ts) is responsible for tier-cap/eviction policy
 * (brief §40) since that requires comparing against OTHER candidates,
 * which isn't a property of a single tag's evidence.
 */
export function evaluateHashtagLifecycle(state: HashtagLifecycleState, evidence: LifecycleEvidence, now: Date): TierDecision {
  if (state.tier === "CORE") return { ...HOLD, reason: "core_never_auto_transitions" };
  if (!hysteresisElapsed(state.tierChangedAt, now)) return { ...HOLD, reason: "hysteresis_window_active" };

  switch (state.tier) {
    case "DORMANT": {
      if (evidence.recentQualifiedPostsAnyPath >= PASSIVE_REVIVAL.minViralPostsViaOtherTags) {
        return { action: "promote", toTier: "EXPLORATION", reason: "passive_revival" };
      }
      return { ...HOLD, reason: "no_revival_evidence" };
    }

    case "EXPLORATION": {
      const meetsPromotionEvidence =
        (evidence.qualifiedPostsInTier >= EXPLORATION_PROMOTION.minQualifiedPosts &&
          evidence.distinctCreatorsInTier >= EXPLORATION_PROMOTION.minDistinctCreators) ||
        (EXPLORATION_PROMOTION.promoteOnTrendStates as readonly TrendState[]).includes(evidence.trendState);
      if (meetsPromotionEvidence) {
        return { action: "promote", toTier: "ACTIVE", reason: "exploration_criteria_met" };
      }
      if (state.probesInTier >= EXPLORATION_DEMOTION.minProbes && state.daysInTier >= EXPLORATION_DEMOTION.windowDays) {
        return { action: "demote", toTier: "DORMANT", reason: "exploration_probes_exhausted" };
      }
      return { ...HOLD, reason: "still_probing" };
    }

    case "ACTIVE": {
      if (evidence.consecutiveWeakTrendStateEvals >= ACTIVE_DEMOTION.consecutiveWeakTrendStateEvals) {
        return { action: "demote", toTier: "DORMANT", reason: "consecutive_weak_trend_state" };
      }
      if (evidence.consecutiveEmptyScans >= ACTIVE_DEMOTION.consecutiveZeroViralScans) {
        return { action: "demote", toTier: "DORMANT", reason: "consecutive_zero_viral_scans" };
      }
      return { ...HOLD, reason: "active_performing" };
    }

    default:
      return { ...HOLD, reason: "unreachable" };
  }
}

/**
 * Eviction policy for a capped tier (brief §40): when a NEW promotion
 * would exceed the cap, the incoming candidate only displaces the
 * current weakest member if it's genuinely stronger — otherwise the
 * candidate simply holds at its current tier (queued, not promoted).
 * `priority` is any deterministic, comparable score (e.g. the
 * candidate's / weakest member's recent qualified-post evidence) —
 * this function doesn't compute it, only compares.
 */
export function decideTierCapEviction(params: {
  currentSize: number;
  cap: number;
  incomingPriority: number;
  weakestCurrentPriority: number | null;
}): { admit: boolean; evictWeakest: boolean } {
  if (params.currentSize < params.cap) return { admit: true, evictWeakest: false };
  if (params.weakestCurrentPriority === null) return { admit: false, evictWeakest: false };
  const stronger = params.incomingPriority > params.weakestCurrentPriority;
  return { admit: stronger, evictWeakest: stronger };
}
