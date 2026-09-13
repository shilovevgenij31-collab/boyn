import { describe, expect, it } from "vitest";
import { combineWeighted } from "@/core/analytics/weighting.ts";

describe("combineWeighted", () => {
  it("combines all available components using their configured weights when everything is present", () => {
    const result = combineWeighted([
      { key: "a", value: 1, weight: 0.5 },
      { key: "b", value: 0, weight: 0.5 },
    ]);
    expect(result?.value).toBeCloseTo(0.5, 10);
    expect(result?.weightsUsed).toEqual({ a: 0.5, b: 0.5 });
  });

  it("drops a missing component and renormalizes the remaining weights to sum to 1", () => {
    const result = combineWeighted([
      { key: "a", value: 1, weight: 0.35 },
      { key: "b", value: null, weight: 0.2 }, // missing
      { key: "c", value: 0.5, weight: 0.15 },
    ]);
    // remaining weights 0.35 and 0.15 renormalize to 0.7 and 0.3
    expect(result?.weightsUsed.a).toBeCloseTo(0.35 / 0.5, 10);
    expect(result?.weightsUsed.c).toBeCloseTo(0.15 / 0.5, 10);
    expect(result?.weightsUsed.b).toBeUndefined();
    expect(result?.value).toBeCloseTo((0.35 / 0.5) * 1 + (0.15 / 0.5) * 0.5, 10);
  });

  it("a component with weight 0 is excluded even if its value is available", () => {
    const result = combineWeighted([
      { key: "a", value: 1, weight: 1 },
      { key: "b", value: 1, weight: 0 },
    ]);
    expect(result?.weightsUsed.b).toBeUndefined();
    expect(result?.value).toBeCloseTo(1, 10);
  });

  it("nothing available -> null, never a fabricated 0", () => {
    const result = combineWeighted([
      { key: "a", value: null, weight: 0.5 },
      { key: "b", value: null, weight: 0.5 },
    ]);
    expect(result).toBeNull();
  });

  it("never produces NaN or Infinity across a range of inputs", () => {
    const result = combineWeighted([
      { key: "a", value: 1e10, weight: 0.9 },
      { key: "b", value: -1e10, weight: 0.1 },
    ]);
    expect(Number.isFinite(result?.value)).toBe(true);
  });
});
