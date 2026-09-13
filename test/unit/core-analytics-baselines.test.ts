import { describe, expect, it } from "vitest";
import { clamp, computeRobustBaseline, isBaselineReliable, log1p, mad, median, robustZ, sigmoid } from "@/core/analytics/baselines.ts";

describe("median", () => {
  it("computes the median of an odd-length array", () => {
    expect(median([1, 3, 2])).toBe(2);
  });
  it("computes the median of an even-length array (average of the two middle)", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("empty array -> 0, not NaN", () => {
    expect(median([])).toBe(0);
  });
});

describe("mad", () => {
  it("computes the median absolute deviation", () => {
    expect(mad([1, 1, 1, 1, 10])).toBe(0); // median=1, deviations [0,0,0,0,9], median of those = 0
  });
  it("empty array -> 0", () => {
    expect(mad([])).toBe(0);
  });
});

describe("log1p", () => {
  it("matches Math.log1p for positive values", () => {
    expect(log1p(100)).toBeCloseTo(Math.log1p(100), 10);
  });
  it("clamps negative input to 0 rather than producing NaN", () => {
    expect(Number.isFinite(log1p(-5))).toBe(true);
  });
});

describe("robustZ", () => {
  it("MAD = 0 (degenerate sample) falls back to z=0 rather than Infinity/NaN", () => {
    const baseline = { medianLog1p: log1p(1000), madLog1p: 0, n: 5 };
    const z = robustZ(5000, baseline);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBe(0);
  });

  it("clamps extreme outliers to the configured asymmetric bounds", () => {
    const baseline = { medianLog1p: log1p(100), madLog1p: 0.1, n: 200 };
    const extremeHigh = robustZ(1e15, baseline);
    const extremeLow = robustZ(0, baseline);
    expect(Number.isFinite(extremeHigh)).toBe(true);
    expect(Number.isFinite(extremeLow)).toBe(true);
    expect(extremeHigh).toBeLessThanOrEqual(5);
    expect(extremeLow).toBeGreaterThanOrEqual(-3);
  });

  it("a value at the median has z close to 0", () => {
    const baseline = { medianLog1p: log1p(1000), madLog1p: 0.5, n: 200 };
    expect(robustZ(1000, baseline)).toBeCloseTo(0, 5);
  });
});

describe("sigmoid", () => {
  it("z=0 -> 0.5", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
  });
  it("is monotonic increasing", () => {
    expect(sigmoid(1)).toBeGreaterThan(sigmoid(0));
    expect(sigmoid(-1)).toBeLessThan(sigmoid(0));
  });
  it("stays within (0, 1) for realistic z magnitudes", () => {
    expect(sigmoid(15)).toBeLessThan(1);
    expect(sigmoid(-15)).toBeGreaterThan(0);
  });

  it("never produces NaN or negative values, even for extreme z", () => {
    expect(Number.isNaN(sigmoid(1000))).toBe(false);
    expect(sigmoid(1000)).toBeLessThanOrEqual(1);
    expect(sigmoid(-1000)).toBeGreaterThanOrEqual(0);
  });
});

describe("clamp", () => {
  it("clamps within bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

describe("computeRobustBaseline", () => {
  it("computes median/MAD on the log1p scale and records the sample size", () => {
    const baseline = computeRobustBaseline([1000, 2000, 3000, 4000, 5000]);
    expect(baseline.n).toBe(5);
    expect(baseline.medianLog1p).toBeCloseTo(log1p(3000), 10);
  });
});

describe("isBaselineReliable", () => {
  it("insufficient sample -> not reliable", () => {
    expect(isBaselineReliable(4)).toBe(false);
  });
  it("sufficient sample -> reliable", () => {
    expect(isBaselineReliable(50)).toBe(true);
    expect(isBaselineReliable(500)).toBe(true);
  });
});
