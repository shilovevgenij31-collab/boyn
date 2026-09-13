/**
 * Golden post-scoring scenarios (Phase 6 brief §51-52) — the full
 * pipeline (velocity -> acceleration -> qualification -> TrendScore/
 * RisingScore -> trend state) run end to end on synthetic, intuitive
 * cases. Assertions target meaningful ordering/ranges, not fragile exact
 * decimals (brief §52).
 */
import { describe, expect, it } from "vitest";
import { computeVelocity, type VelocitySnapshot } from "@/core/analytics/velocity.ts";
import { computeAcceleration } from "@/core/analytics/acceleration.ts";
import { ageHoursSince } from "@/core/analytics/freshness.ts";
import { classifyPostTier } from "@/core/analytics/qualification.ts";
import { assembleScore, type PlatformBaselines } from "@/core/analytics/scoring.ts";
import { computeRobustBaseline } from "@/core/analytics/baselines.ts";
import { derivePostTrendState } from "@/core/analytics/trend-state.ts";
import { RISING_SCORE_WEIGHTS, TREND_SCORE_WEIGHTS } from "@/config/scoring.ts";
import type { ContentType } from "@/core/domain/content-type.ts";

const baselines: PlatformBaselines = {
  views: computeRobustBaseline([10_000, 20_000, 30_000, 50_000, 100_000, 200_000, 500_000]),
  vph: computeRobustBaseline([200, 500, 1000, 2000, 5000, 10_000]),
  likeRatio: computeRobustBaseline([0.02, 0.03, 0.05, 0.08]),
  commentRatio: computeRobustBaseline([0.001, 0.003, 0.005]),
  shareRatio: computeRobustBaseline([0.002, 0.005, 0.01]),
};

interface ScenarioInput {
  publishedAt: Date;
  now: Date;
  snapshots: VelocitySnapshot[];
  likes: number | null;
  comments: number | null;
  shares: number | null;
  contentType?: ContentType;
}

function latestViews(snapshots: VelocitySnapshot[]): number | null {
  const withViews = snapshots.filter((s) => s.views !== null);
  if (withViews.length === 0) return null;
  return [...withViews].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime()).at(-1)!.views;
}

function runPipeline(input: ScenarioInput) {
  const ageHours = ageHoursSince(input.publishedAt, input.now);
  const velocity = computeVelocity({ snapshots: input.snapshots, publishedAt: input.publishedAt, now: input.now });
  const acceleration = computeAcceleration(velocity.vph, velocity.vphPrevious, velocity.confidence);
  const views = latestViews(input.snapshots);

  const qualification = classifyPostTier({
    views,
    publishedAt: input.publishedAt,
    contentType: input.contentType ?? "video",
    availability: "ACTIVE",
    ageHours,
    vph: velocity.vph,
    vphConfidence: velocity.confidence,
    comments: input.comments,
    shares: input.shares,
  });

  const scoringInput = {
    views,
    metrics: { views, likes: input.likes, comments: input.comments, shares: input.shares },
    ageHours,
    vph: velocity.vph,
    vphKind: velocity.kind,
    vphConfidence: velocity.confidence,
    acceleration,
    hashtagMomentum: null,
    baselines,
  };
  const trendScoreResult = assembleScore(scoringInput, TREND_SCORE_WEIGHTS);
  const risingScoreResult = assembleScore(scoringInput, RISING_SCORE_WEIGHTS);
  const trendState = derivePostTrendState({ ageHours, trendScore: trendScoreResult.score, risingScore: risingScoreResult.score, acceleration, vph: velocity.vph });

  return { ageHours, velocity, acceleration, qualification, trendScore: trendScoreResult.score, risingScore: risingScoreResult.score, trendState };
}

const T = new Date("2026-09-12T12:00:00.000Z"); // "now" for every scenario
function hoursBefore(h: number): Date {
  return new Date(T.getTime() - h * 3_600_000);
}
function hoursAfter(base: Date, h: number): Date {
  return new Date(base.getTime() + h * 3_600_000);
}

describe("A: EARLY BREAKOUT — young, moderate views, very high observed VPH, positive acceleration", () => {
  const publishedAt = hoursBefore(3);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 0.8), views: 8_000 },
      { observedAt: hoursAfter(publishedAt, 1.6), views: 20_000 }, // real interval #1: 15000/h
      { observedAt: hoursAfter(publishedAt, 2.4), views: 35_000 }, // real interval #2: 18750/h -> accelerating
    ],
    likes: 1200,
    comments: 40,
    shares: 60,
  });

  it("has a high RisingScore", () => {
    expect(result.risingScore).toBeGreaterThan(60);
  });
  it("qualifies as EARLY_BREAKOUT and reports BREAKOUT trend state", () => {
    expect(result.qualification.tier).toBe("EARLY_BREAKOUT");
    expect(result.trendState).toBe("BREAKOUT");
  });
  it("has positive acceleration", () => {
    expect(result.acceleration).toBeGreaterThan(0);
  });
});

describe("B: HUGE BUT FLAT — millions of views, ~36h old, near-zero current VPH", () => {
  const publishedAt = hoursBefore(36);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 34), views: 3_000_000 },
      { observedAt: hoursAfter(publishedAt, 35.5), views: 3_000_100 },
    ],
    likes: 200_000,
    comments: 3_000,
    shares: 1_000,
  });

  it("has low current velocity", () => {
    expect(result.velocity.vph!).toBeLessThan(1000);
  });
  it("does NOT qualify as BREAKOUT or RISING", () => {
    expect(result.trendState).not.toBe("BREAKOUT");
    expect(result.trendState).not.toBe("RISING");
  });
  it("has a low RisingScore despite massive reach", () => {
    expect(result.risingScore).toBeLessThan(40);
  });
});

describe("A vs B: fast fresh breakout outranks the huge flat post on RisingScore", () => {
  it("RisingScore(A) > RisingScore(B)", () => {
    const a = runPipeline({
      publishedAt: hoursBefore(2),
      now: T,
      snapshots: [
        { observedAt: hoursAfter(hoursBefore(2), 0.8), views: 8_000 },
        { observedAt: hoursAfter(hoursBefore(2), 1.6), views: 20_000 },
      ],
      likes: 1200,
      comments: 40,
      shares: 60,
    });
    const b = runPipeline({
      publishedAt: hoursBefore(36),
      now: T,
      snapshots: [
        { observedAt: hoursAfter(hoursBefore(36), 34), views: 3_000_000 },
        { observedAt: hoursAfter(hoursBefore(36), 35.5), views: 3_000_100 },
      ],
      likes: 200_000,
      comments: 3_000,
      shares: 1_000,
    });
    expect(a.risingScore!).toBeGreaterThan(b.risingScore!);
  });
});

describe("C: STEADY VIRAL — 12h old, strong views, healthy velocity, no acceleration data", () => {
  const publishedAt = hoursBefore(12);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 1), views: 40_000 },
      { observedAt: hoursAfter(publishedAt, 11), views: 200_000 }, // the one real (non-birth) interval
    ],
    likes: 15_000,
    comments: 500,
    shares: 800,
  });

  it("has no acceleration signal (only one real interval)", () => {
    expect(result.velocity.confidence).toBe("MEDIUM");
    expect(result.acceleration).toBeNull();
  });
  it("has a high TrendScore", () => {
    expect(result.trendScore!).toBeGreaterThan(50);
  });
  it("reports ACTIVE or RISING, not DEAD/FALLING", () => {
    expect(["ACTIVE", "RISING"]).toContain(result.trendState);
  });
});

describe("D: NEW LOW-DATA POST — under 1h old, one snapshot, modest views", () => {
  const publishedAt = hoursBefore(0.5);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [{ observedAt: T, views: 3_000 }],
    likes: 100,
    comments: 5,
    shares: 2,
  });

  it("uses an estimated, low-confidence velocity", () => {
    expect(result.velocity.kind).toBe("ESTIMATED");
    expect(result.velocity.confidence).toBe("LOW");
  });
  it("is not falsely top-ranked despite a technically high raw rate", () => {
    expect(result.risingScore!).toBeLessThan(90);
  });
});

describe("E: INSTAGRAM WITHOUT SHARES — strong likes/comments, shares null", () => {
  const publishedAt = hoursBefore(10);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 5), views: 40_000 },
      { observedAt: hoursAfter(publishedAt, 9), views: 90_000 },
    ],
    likes: 8_000,
    comments: 300,
    shares: null,
  });

  it("engagement is still a valid, available component", () => {
    const trendResult = assembleScore(
      {
        views: 90_000,
        metrics: { views: 90_000, likes: 8_000, comments: 300, shares: null },
        ageHours: 10,
        vph: result.velocity.vph,
        vphKind: result.velocity.kind,
        vphConfidence: result.velocity.confidence,
        acceleration: result.acceleration,
        hashtagMomentum: null,
        baselines,
      },
      TREND_SCORE_WEIGHTS,
    );
    const engagement = trendResult.components.find((c) => c.component === "engagement")!;
    expect(engagement.available).toBe(true);
    expect(engagement.normalized).not.toBeNull();
    // Not crushed toward 0 just because shares is missing.
    expect(engagement.normalized!).toBeGreaterThan(0.3);
  });
});

describe("F: NEGATIVE PROVIDER DELTA — a later snapshot reports fewer views", () => {
  const publishedAt = hoursBefore(10);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 5), views: 50_000 },
      { observedAt: hoursAfter(publishedAt, 9), views: 40_000 },
    ],
    likes: 1000,
    comments: 50,
    shares: 20,
  });

  it("never produces a negative VPH", () => {
    expect(result.velocity.vph!).toBeGreaterThanOrEqual(0);
  });
  it("flags the anomaly defensively", () => {
    expect(result.velocity.hadNegativeDeltaAnomaly).toBe(true);
  });
  it("score is still a finite, sane number", () => {
    expect(Number.isFinite(result.trendScore)).toBe(true);
  });
});

describe("G: FALLING POST — fast prior interval, slow recent interval", () => {
  const publishedAt = hoursBefore(20);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 5), views: 50_000 },
      { observedAt: hoursAfter(publishedAt, 10), views: 250_000 }, // fast: 40000/h
      { observedAt: hoursAfter(publishedAt, 19), views: 270_000 }, // slow: 2222/h
    ],
    likes: 20_000,
    comments: 600,
    shares: 900,
  });

  it("has negative acceleration", () => {
    expect(result.acceleration!).toBeLessThan(0);
  });
  it("reports FALLING trend state", () => {
    expect(result.trendState).toBe("FALLING");
  });
});

describe("H: DEAD OLD POST — over 72h old, large views, no meaningful recent growth", () => {
  const publishedAt = hoursBefore(100);
  const result = runPipeline({
    publishedAt,
    now: T,
    snapshots: [
      { observedAt: hoursAfter(publishedAt, 97), views: 2_000_000 },
      { observedAt: hoursAfter(publishedAt, 99), views: 2_000_010 },
    ],
    likes: 100_000,
    comments: 2_000,
    shares: 500,
  });

  it("reports DEAD trend state", () => {
    expect(result.trendState).toBe("DEAD");
  });
  it("does not qualify for VIRAL_QUALIFIED or WATCH (both are age-windowed)", () => {
    expect(result.qualification.tier).toBe("NOISE");
  });
});
