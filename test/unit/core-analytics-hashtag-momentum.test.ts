import { describe, expect, it } from "vitest";
import { computeHashtagGrowth, computeHashtagMomentum, computePostHashtagMomentum } from "@/core/analytics/hashtag-momentum.ts";

describe("computeHashtagGrowth", () => {
  it("v24 === b7 -> g close to 0 (flat)", () => {
    expect(computeHashtagGrowth(5, 5)).toBeCloseTo(0, 10);
  });

  it("0 -> 1 does not read as infinite growth (smoothing prior)", () => {
    const g = computeHashtagGrowth(1, 0);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeGreaterThan(0);
  });

  it("more posts than baseline -> positive growth", () => {
    expect(computeHashtagGrowth(10, 2)).toBeGreaterThan(0);
  });

  it("fewer posts than baseline -> negative growth", () => {
    expect(computeHashtagGrowth(1, 10)).toBeLessThan(0);
  });
});

describe("computeHashtagMomentum", () => {
  it("is bounded in [0, 1]", () => {
    expect(computeHashtagMomentum(5, 10)).toBeLessThanOrEqual(1);
    expect(computeHashtagMomentum(-5, 0)).toBeGreaterThanOrEqual(0);
  });

  it("small-sample defense: v24=1 contributes far less than a sustained run at the same growth rate", () => {
    const g = 2;
    const oneOff = computeHashtagMomentum(g, 1);
    const sustained = computeHashtagMomentum(g, 10);
    expect(sustained).toBeGreaterThan(oneOff);
  });

  it("v24=0 -> momentum 0 regardless of g (no posts, no momentum)", () => {
    expect(computeHashtagMomentum(5, 0)).toBeCloseTo(0, 10);
  });
});

describe("computePostHashtagMomentum", () => {
  it("averages the top-K known momentums", () => {
    const result = computePostHashtagMomentum([0.9, 0.8, 0.7, 0.1]);
    // top 3 (config default K=3): 0.9, 0.8, 0.7 -> mean 0.8
    expect(result).toBeCloseTo(0.8, 5);
  });

  it("unknown-momentum tags (null) are excluded, not treated as 0", () => {
    const result = computePostHashtagMomentum([null, null, 0.6]);
    expect(result).toBeCloseTo(0.6, 5);
  });

  it("no known-momentum tags at all -> null, not 0", () => {
    expect(computePostHashtagMomentum([null, null])).toBeNull();
    expect(computePostHashtagMomentum([])).toBeNull();
  });
});
