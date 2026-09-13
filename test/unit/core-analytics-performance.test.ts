/**
 * Performance diagnostic (Phase 6 brief §49, §77): the pure, in-memory
 * per-post computation (velocity -> acceleration -> qualification ->
 * TrendScore/RisingScore -> trend state) for ~5,000 posts with realistic
 * snapshot counts should complete quickly — no O(posts x allPosts)
 * algorithm anywhere in that path. Database I/O (batched separately in
 * jobs/run-analytics.ts) is deliberately NOT part of this measurement —
 * PGlite/individual-row round trips at this scale would make the
 * threshold either unrealistically loose or CI-flaky for no diagnostic
 * value (brief §77 explicitly allows measuring this separately).
 *
 * The threshold here is generous on purpose (a regression guard, not a
 * tight benchmark assertion) so normal CI variance never makes this
 * flaky.
 */
import { describe, expect, it } from "vitest";
import { computeVelocity, type VelocitySnapshot } from "@/core/analytics/velocity.ts";
import { computeAcceleration } from "@/core/analytics/acceleration.ts";
import { ageHoursSince } from "@/core/analytics/freshness.ts";
import { classifyPostTier } from "@/core/analytics/qualification.ts";
import { assembleScore, type PlatformBaselines } from "@/core/analytics/scoring.ts";
import { computeRobustBaseline } from "@/core/analytics/baselines.ts";
import { derivePostTrendState } from "@/core/analytics/trend-state.ts";
import { TREND_SCORE_WEIGHTS, RISING_SCORE_WEIGHTS } from "@/config/scoring.ts";

const POST_COUNT = 5_000;
const GENEROUS_THRESHOLD_MS = 3_000;

function buildSyntheticPost(seed: number, now: Date) {
  const ageHours = 0.5 + (seed % 72);
  const publishedAt = new Date(now.getTime() - ageHours * 3_600_000);
  const baseViews = 1_000 + (seed % 500) * 1_000;
  const snapshots: VelocitySnapshot[] = [
    { observedAt: new Date(publishedAt.getTime() + 1 * 3_600_000), views: Math.round(baseViews * 0.3) },
    { observedAt: new Date(publishedAt.getTime() + Math.min(ageHours - 0.5, 6) * 3_600_000), views: Math.round(baseViews * 0.7) },
    { observedAt: new Date(now.getTime() - 0.25 * 3_600_000), views: baseViews },
  ];
  return {
    publishedAt,
    snapshots,
    likes: Math.round(baseViews * 0.05),
    comments: Math.round(baseViews * 0.002),
    shares: seed % 7 === 0 ? null : Math.round(baseViews * 0.01), // some missing, like real Instagram data
  };
}

describe("Phase 6 analytics performance diagnostic", () => {
  it(`scores ${POST_COUNT} synthetic posts (pure computation only) well within a generous regression threshold`, () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const baselines: PlatformBaselines = {
      views: computeRobustBaseline(Array.from({ length: 200 }, (_, i) => 1000 + i * 5000)),
      vph: computeRobustBaseline(Array.from({ length: 200 }, (_, i) => 100 + i * 200)),
      likeRatio: computeRobustBaseline(Array.from({ length: 200 }, (_, i) => 0.01 + i * 0.0005)),
      commentRatio: computeRobustBaseline(Array.from({ length: 200 }, (_, i) => 0.001 + i * 0.00005)),
      shareRatio: computeRobustBaseline(Array.from({ length: 200 }, (_, i) => 0.002 + i * 0.0001)),
    };

    const started = performance.now();

    let scoredCount = 0;
    for (let i = 0; i < POST_COUNT; i++) {
      const synthetic = buildSyntheticPost(i, now);
      const ageHours = ageHoursSince(synthetic.publishedAt, now);
      const velocity = computeVelocity({ snapshots: synthetic.snapshots, publishedAt: synthetic.publishedAt, now });
      const acceleration = computeAcceleration(velocity.vph, velocity.vphPrevious, velocity.confidence);
      const views = synthetic.snapshots.at(-1)!.views;

      const qualification = classifyPostTier({
        views,
        publishedAt: synthetic.publishedAt,
        contentType: "video",
        availability: "ACTIVE",
        ageHours,
        vph: velocity.vph,
        vphConfidence: velocity.confidence,
        comments: synthetic.comments,
        shares: synthetic.shares,
      });

      const scoringInput = {
        views,
        metrics: { views, likes: synthetic.likes, comments: synthetic.comments, shares: synthetic.shares },
        ageHours,
        vph: velocity.vph,
        vphKind: velocity.kind,
        vphConfidence: velocity.confidence,
        acceleration,
        hashtagMomentum: i % 3 === 0 ? 0.4 : null,
        baselines,
      };
      const trendResult = assembleScore(scoringInput, TREND_SCORE_WEIGHTS);
      const risingResult = assembleScore(scoringInput, RISING_SCORE_WEIGHTS);
      derivePostTrendState({ ageHours, trendScore: trendResult.score, risingScore: risingResult.score, acceleration, vph: velocity.vph });

      if (qualification.tier !== null) scoredCount += 1;
    }

    const elapsedMs = performance.now() - started;

    expect(scoredCount).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(GENEROUS_THRESHOLD_MS);
  });
});
