/**
 * TrendScore / RisingScore assembly (Phase 6 brief §19-20, §24-25, plan
 * §16.3): combines velocity/reach/engagement/freshness/hashtag-momentum/
 * acceleration into one 0..100 score via the generic missing-component-
 * renormalizes-the-rest rule (weighting.ts). Every component is returned
 * in structured, auditable form (brief §25/§63) — no natural-language
 * explanation is generated here, that's a future `/why` command's job.
 */
import { robustZ, sigmoid, type RobustBaseline } from "./baselines.ts";
import { combineWeighted } from "./weighting.ts";
import { computeEngagementRatios, type EngagementMetrics } from "./engagement.ts";
import { computeFreshness } from "./freshness.ts";
import { ESTIMATED_VELOCITY_SHRINK, ENGAGEMENT_RATIO_WEIGHTS, type ScoreWeights } from "@/config/scoring.ts";
import { clamp } from "./baselines.ts";
import type { VelocityConfidence, VelocityKind } from "./velocity.ts";

export interface PlatformBaselines {
  views: RobustBaseline;
  vph: RobustBaseline;
  likeRatio: RobustBaseline;
  commentRatio: RobustBaseline;
  shareRatio: RobustBaseline;
}

export interface ScoringInput {
  views: number | null;
  metrics: EngagementMetrics;
  ageHours: number;
  vph: number | null;
  vphKind: VelocityKind;
  vphConfidence: VelocityConfidence;
  /** Already computed by acceleration.ts (null unless velocity confidence
   * is HIGH). */
  acceleration: number | null;
  /** Already computed by hashtag-momentum.ts / post-level aggregation
   * (null when the post has no non-generic tracked-momentum tags). */
  hashtagMomentum: number | null;
  baselines: PlatformBaselines;
}

export type ComponentKey = "velocity" | "reach" | "engagement" | "freshness" | "hashtagMomentum" | "acceleration";

export interface ComponentDetail {
  component: ComponentKey;
  available: boolean;
  raw: number | null;
  z: number | null;
  normalized: number | null;
  weightConfigured: number;
  weightUsed: number | null;
}

export interface ScoreResult {
  /** 0..100, or `null` if not even one component was available. */
  score: number | null;
  components: ComponentDetail[];
}

function velocityComponent(input: ScoringInput): { raw: number | null; z: number | null; normalized: number | null } {
  if (input.vph === null) return { raw: null, z: null, normalized: null };
  const z = robustZ(input.vph, input.baselines.vph);
  let normalized = sigmoid(z);
  if (input.vphKind === "ESTIMATED") {
    // A lifetime average overstates the CURRENT speed of an older post —
    // shrink toward the neutral midpoint the older the post is.
    const k = clamp(1 - input.ageHours / ESTIMATED_VELOCITY_SHRINK.maxAgeForFullShrinkHours, ESTIMATED_VELOCITY_SHRINK.kMin, ESTIMATED_VELOCITY_SHRINK.kMax);
    normalized = 0.5 + (normalized - 0.5) * k;
  }
  return { raw: input.vph, z, normalized };
}

function reachComponent(input: ScoringInput): { raw: number | null; z: number | null; normalized: number | null } {
  if (input.views === null) return { raw: null, z: null, normalized: null };
  const z = robustZ(input.views, input.baselines.views);
  return { raw: input.views, z, normalized: sigmoid(z) };
}

function engagementComponent(input: ScoringInput): { raw: number | null; z: number | null; normalized: number | null } {
  const ratios = computeEngagementRatios(input.metrics);
  const combined = combineWeighted([
    { key: "like", value: ratios.likeRatio !== null ? sigmoid(robustZ(ratios.likeRatio, input.baselines.likeRatio)) : null, weight: ENGAGEMENT_RATIO_WEIGHTS.like },
    { key: "comment", value: ratios.commentRatio !== null ? sigmoid(robustZ(ratios.commentRatio, input.baselines.commentRatio)) : null, weight: ENGAGEMENT_RATIO_WEIGHTS.comment },
    { key: "share", value: ratios.shareRatio !== null ? sigmoid(robustZ(ratios.shareRatio, input.baselines.shareRatio)) : null, weight: ENGAGEMENT_RATIO_WEIGHTS.share },
  ]);
  if (!combined) return { raw: null, z: null, normalized: null };
  return { raw: null, z: null, normalized: combined.value };
}

function freshnessComponent(input: ScoringInput): { raw: number; normalized: number } {
  return { raw: input.ageHours, normalized: computeFreshness(input.ageHours) };
}

function hashtagMomentumComponent(input: ScoringInput): { raw: number | null; normalized: number | null } {
  return { raw: input.hashtagMomentum, normalized: input.hashtagMomentum };
}

function accelerationComponent(input: ScoringInput): { raw: number | null; normalized: number | null } {
  if (input.acceleration === null) return { raw: null, normalized: null };
  return { raw: input.acceleration, normalized: sigmoid(input.acceleration) };
}

/** Shared assembly for both TrendScore and RisingScore — they differ
 * only in which `ScoreWeights` are passed in (config/scoring.ts's
 * TREND_SCORE_WEIGHTS / RISING_SCORE_WEIGHTS). A weight of 0 for a given
 * score (e.g. RisingScore's reach/hashtagMomentum) simply excludes that
 * component from this score entirely, same as if it were unavailable. */
export function assembleScore(input: ScoringInput, weights: ScoreWeights): ScoreResult {
  const velocity = velocityComponent(input);
  const reach = reachComponent(input);
  const engagement = engagementComponent(input);
  const freshness = freshnessComponent(input);
  const hashtagMomentum = hashtagMomentumComponent(input);
  const acceleration = accelerationComponent(input);

  const raw: Record<ComponentKey, { raw: number | null; z?: number | null; normalized: number | null }> = {
    velocity,
    reach,
    engagement,
    freshness,
    hashtagMomentum,
    acceleration,
  };

  const combined = combineWeighted([
    { key: "velocity", value: velocity.normalized, weight: weights.velocity },
    { key: "reach", value: reach.normalized, weight: weights.reach },
    { key: "engagement", value: engagement.normalized, weight: weights.engagement },
    { key: "freshness", value: freshness.normalized, weight: weights.freshness },
    { key: "hashtagMomentum", value: hashtagMomentum.normalized, weight: weights.hashtagMomentum },
    { key: "acceleration", value: acceleration.normalized, weight: weights.acceleration },
  ]);

  const configuredWeight: Record<ComponentKey, number> = {
    velocity: weights.velocity,
    reach: weights.reach,
    engagement: weights.engagement,
    freshness: weights.freshness,
    hashtagMomentum: weights.hashtagMomentum,
    acceleration: weights.acceleration,
  };

  const components: ComponentDetail[] = (Object.keys(raw) as ComponentKey[]).map((key) => {
    const r = raw[key];
    const weightUsed = combined?.weightsUsed[key] ?? null;
    return {
      component: key,
      available: r.normalized !== null && configuredWeight[key] > 0,
      raw: r.raw,
      z: "z" in r ? (r.z ?? null) : null,
      normalized: r.normalized,
      weightConfigured: configuredWeight[key],
      weightUsed,
    };
  });

  if (!combined) return { score: null, components };

  const score = Math.round(100 * clamp(combined.value, 0, 1));
  return { score, components };
}

/** Structured, non-prose breakdown for a future `/why` command (brief
 * §25/§63) — currently just the ScoreResult's own components, kept as a
 * named export so callers don't need to know that. */
export function explainScore(result: ScoreResult): ComponentDetail[] {
  return result.components;
}
