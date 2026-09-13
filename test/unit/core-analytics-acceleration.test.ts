import { describe, expect, it } from "vitest";
import { computeAcceleration } from "@/core/analytics/acceleration.ts";

describe("computeAcceleration", () => {
  it("positive: current rate double the previous -> +1 (log2(2))", () => {
    expect(computeAcceleration(10_000, 5_000, "HIGH")).toBeCloseTo(1, 5);
  });

  it("flat: current === previous -> 0", () => {
    expect(computeAcceleration(5_000, 5_000, "HIGH")).toBeCloseTo(0, 5);
  });

  it("negative: current rate halved -> -1", () => {
    expect(computeAcceleration(2_500, 5_000, "HIGH")).toBeCloseTo(-1, 5);
  });

  it("insufficient data (confidence not HIGH) -> null, never a fabricated 0", () => {
    expect(computeAcceleration(10_000, 5_000, "MEDIUM")).toBeNull();
    expect(computeAcceleration(10_000, 5_000, "LOW")).toBeNull();
    expect(computeAcceleration(10_000, 5_000, null)).toBeNull();
  });

  it("missing either rate -> null", () => {
    expect(computeAcceleration(null, 5_000, "HIGH")).toBeNull();
    expect(computeAcceleration(10_000, null, "HIGH")).toBeNull();
  });

  it("a zero/negative previous rate has no meaningful ratio -> null", () => {
    expect(computeAcceleration(10_000, 0, "HIGH")).toBeNull();
  });

  it("growth stopped entirely (current 0) -> clamped floor, not -Infinity", () => {
    const result = computeAcceleration(0, 5_000, "HIGH");
    expect(result).not.toBeNull();
    expect(Number.isFinite(result)).toBe(true);
  });

  it("never returns NaN or Infinity for extreme ratios", () => {
    const huge = computeAcceleration(1e12, 1, "HIGH");
    expect(Number.isFinite(huge)).toBe(true);
    const tiny = computeAcceleration(1, 1e12, "HIGH");
    expect(Number.isFinite(tiny)).toBe(true);
  });
});
