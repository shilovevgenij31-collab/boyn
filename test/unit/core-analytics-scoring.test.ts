import { describe, expect, it } from "vitest";
import { assembleScore, type PlatformBaselines, type ScoringInput } from "@/core/analytics/scoring.ts";
import { RISING_SCORE_WEIGHTS, TREND_SCORE_WEIGHTS } from "@/config/scoring.ts";
import { computeRobustBaseline } from "@/core/analytics/baselines.ts";

const baselines: PlatformBaselines = {
  views: computeRobustBaseline([10_000, 20_000, 30_000, 50_000, 100_000, 200_000]),
  vph: computeRobustBaseline([500, 1000, 2000, 5000, 10_000]),
  likeRatio: computeRobustBaseline([0.02, 0.03, 0.05, 0.08]),
  commentRatio: computeRobustBaseline([0.001, 0.003, 0.005]),
  shareRatio: computeRobustBaseline([0.002, 0.005, 0.01]),
};

function baseInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    views: 50_000,
    metrics: { views: 50_000, likes: 2_000, comments: 100, shares: 300 },
    ageHours: 5,
    vph: 8_000,
    vphKind: "OBSERVED",
    vphConfidence: "HIGH",
    acceleration: 0.5,
    hashtagMomentum: 0.6,
    baselines,
    ...overrides,
  };
}

describe("assembleScore", () => {
  it("produces a 0..100 score when every component is available", () => {
    const result = assembleScore(baseInput(), TREND_SCORE_WEIGHTS);
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(100);
  });

  it("exact weight renormalization when acceleration is missing", () => {
    const withoutAccel = assembleScore(baseInput({ acceleration: null }), TREND_SCORE_WEIGHTS);

    const accelDetail = withoutAccel.components.find((c) => c.component === "acceleration")!;
    expect(accelDetail.available).toBe(false);
    expect(accelDetail.weightUsed).toBeNull();

    // The other components' weights should renormalize to sum to 1
    // across whatever remains available — acceleration's configured
    // 0.05 is redistributed proportionally, not dropped silently.
    const usedWeights = withoutAccel.components.filter((c) => c.weightUsed !== null).map((c) => c.weightUsed!);
    const sum = usedWeights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 8);

    const remainingConfiguredSum = 1 - TREND_SCORE_WEIGHTS.acceleration;
    const freshnessDetail = withoutAccel.components.find((c) => c.component === "freshness")!;
    expect(freshnessDetail.weightUsed).toBeCloseTo(TREND_SCORE_WEIGHTS.freshness / remainingConfiguredSum, 8);
  });

  it("missing engagement component renormalizes the rest", () => {
    const result = assembleScore(baseInput({ metrics: { views: 50_000, likes: null, comments: null, shares: null } }), TREND_SCORE_WEIGHTS);
    const engagementDetail = result.components.find((c) => c.component === "engagement")!;
    expect(engagementDetail.available).toBe(false);
    const usedWeights = result.components.filter((c) => c.weightUsed !== null).map((c) => c.weightUsed!);
    expect(usedWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
  });

  it("never emits NaN or Infinity across extreme inputs", () => {
    const result = assembleScore(
      baseInput({ views: 0, vph: 0, metrics: { views: 0, likes: 0, comments: 0, shares: 0 }, ageHours: 100_000, acceleration: null, hashtagMomentum: null }),
      TREND_SCORE_WEIGHTS,
    );
    expect(result.score === null || Number.isFinite(result.score)).toBe(true);
    for (const c of result.components) {
      if (c.z !== null) expect(Number.isFinite(c.z)).toBe(true);
      if (c.normalized !== null) expect(Number.isFinite(c.normalized)).toBe(true);
    }
  });

  it("with every metric-based component missing, only freshness (always known) drives the score — never a fabricated 0 for the rest", () => {
    const result = assembleScore(
      { views: null, metrics: { views: null, likes: null, comments: null, shares: null }, ageHours: 0, vph: null, vphKind: "NONE", vphConfidence: null, acceleration: null, hashtagMomentum: null, baselines },
      TREND_SCORE_WEIGHTS,
    );
    // freshness is always available (age is always known when scoring runs at all),
    // so score is not null here — but let's confirm freshness alone drives it sanely.
    expect(result.score).not.toBeNull();
    const available = result.components.filter((c) => c.available);
    expect(available.map((c) => c.component)).toEqual(["freshness"]);
  });

  it("RisingScore excludes reach and hashtag momentum entirely (weight 0), even when available", () => {
    const result = assembleScore(baseInput(), RISING_SCORE_WEIGHTS);
    const reach = result.components.find((c) => c.component === "reach")!;
    const momentum = result.components.find((c) => c.component === "hashtagMomentum")!;
    expect(reach.weightUsed).toBeNull();
    expect(momentum.weightUsed).toBeNull();
  });

  it("sanity: a fresh, fast-growing post outranks a huge-but-flat one on RisingScore", () => {
    const freshFastGrowing = assembleScore(
      baseInput({ views: 45_000, ageHours: 2, vph: 15_000, vphKind: "OBSERVED", vphConfidence: "HIGH", acceleration: 1 }),
      RISING_SCORE_WEIGHTS,
    );
    const hugeFlat = assembleScore(
      baseInput({ views: 3_000_000, ageHours: 36, vph: 50, vphKind: "OBSERVED", vphConfidence: "HIGH", acceleration: -1 }),
      RISING_SCORE_WEIGHTS,
    );
    expect(freshFastGrowing.score!).toBeGreaterThan(hugeFlat.score!);
  });

  it("sanity: reach still matters on TrendScore (huge steady post scores respectably despite modest current velocity)", () => {
    const hugeButSteady = assembleScore(baseInput({ views: 3_000_000, ageHours: 20, vph: 8_000, vphConfidence: "HIGH", acceleration: 0 }), TREND_SCORE_WEIGHTS);
    const small = assembleScore(baseInput({ views: 5_000, ageHours: 20, vph: 200, vphConfidence: "MEDIUM", acceleration: null }), TREND_SCORE_WEIGHTS);
    expect(hugeButSteady.score!).toBeGreaterThan(small.score!);
  });
});
