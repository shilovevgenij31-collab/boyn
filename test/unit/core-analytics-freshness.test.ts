import { describe, expect, it } from "vitest";
import { ageHoursSince, computeFreshness } from "@/core/analytics/freshness.ts";

describe("computeFreshness", () => {
  it("age 0 -> freshness 1", () => {
    expect(computeFreshness(0)).toBeCloseTo(1, 10);
  });

  it("matches the documented half-life reference points (half-life 18h)", () => {
    expect(computeFreshness(18)).toBeCloseTo(0.5, 5);
    expect(computeFreshness(2)).toBeCloseTo(0.93, 2);
    expect(computeFreshness(12)).toBeCloseTo(0.63, 2);
    expect(computeFreshness(24)).toBeCloseTo(0.4, 2);
    expect(computeFreshness(48)).toBeCloseTo(0.16, 2);
  });

  it("decays monotonically with age", () => {
    const values = [0, 2, 12, 24, 48, 96].map(computeFreshness);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThan(values[i - 1]!);
    }
  });

  it("a negative age (clock skew / future publish date) is clamped to 0, never > 1", () => {
    expect(computeFreshness(-10)).toBeCloseTo(1, 10);
  });

  it("never produces NaN or Infinity for a very large age", () => {
    const value = computeFreshness(1_000_000);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

describe("ageHoursSince", () => {
  it("computes elapsed hours", () => {
    const published = new Date("2026-09-12T00:00:00.000Z");
    const now = new Date("2026-09-12T05:00:00.000Z");
    expect(ageHoursSince(published, now)).toBeCloseTo(5, 10);
  });

  it("clamps a future publish date to 0", () => {
    const published = new Date("2026-09-13T00:00:00.000Z");
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(ageHoursSince(published, now)).toBe(0);
  });
});
