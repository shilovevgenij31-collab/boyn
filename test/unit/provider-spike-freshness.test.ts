import { describe, expect, it } from "vitest";
import { computeFreshnessStats } from "../../scripts/provider-spike/freshness.ts";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}

describe("computeFreshnessStats", () => {
  it("returns all-null stats for an empty sample", () => {
    const stats = computeFreshnessStats([], NOW);
    expect(stats.sampleSize).toBe(0);
    expect(stats.withTimestamp).toBe(0);
    expect(stats.medianAgeHours).toBeNull();
    expect(stats.pctLt24h).toBeNull();
  });

  it("returns all-null age stats when no record has a parseable timestamp", () => {
    const stats = computeFreshnessStats([null, null, null], NOW);
    expect(stats.sampleSize).toBe(3);
    expect(stats.withTimestamp).toBe(0);
    expect(stats.medianAgeHours).toBeNull();
  });

  it("computes median/min/max correctly for a known sample", () => {
    const stats = computeFreshnessStats([hoursAgo(2), hoursAgo(10), hoursAgo(30)], NOW);
    expect(stats.sampleSize).toBe(3);
    expect(stats.withTimestamp).toBe(3);
    expect(stats.medianAgeHours).toBe(10);
    expect(stats.minAgeHours).toBe(2);
    expect(stats.maxAgeHours).toBe(30);
  });

  it("computes threshold percentages correctly", () => {
    // 5 posts: 3h, 10h, 20h, 40h, 100h old
    const stats = computeFreshnessStats(
      [hoursAgo(3), hoursAgo(10), hoursAgo(20), hoursAgo(40), hoursAgo(100)],
      NOW,
    );
    expect(stats.pctLt6h).toBe(20); // just the 3h one
    expect(stats.pctLt12h).toBe(40); // 3h, 10h
    expect(stats.pctLt24h).toBe(60); // 3h, 10h, 20h
    expect(stats.pctLt48h).toBe(80); // + 40h
    expect(stats.pctLt72h).toBe(80); // 100h still excluded
  });

  it("mixes missing and present timestamps without skewing withTimestamp count", () => {
    const stats = computeFreshnessStats([hoursAgo(1), null, hoursAgo(3), null], NOW);
    expect(stats.sampleSize).toBe(4);
    expect(stats.withTimestamp).toBe(2);
    expect(stats.medianAgeHours).toBe(2);
  });

  it("drops future timestamps (clock skew / bad data) rather than reporting a negative age", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    const stats = computeFreshnessStats([hoursAgo(5), future], NOW);
    expect(stats.withTimestamp).toBe(1);
    expect(stats.minAgeHours).toBe(5);
  });

  it("omits p90 for small samples (<5) but includes it for larger ones", () => {
    const small = computeFreshnessStats([hoursAgo(1), hoursAgo(2), hoursAgo(3)], NOW);
    expect(small.p90AgeHours).toBeNull();

    const larger = computeFreshnessStats(
      [hoursAgo(1), hoursAgo(2), hoursAgo(3), hoursAgo(4), hoursAgo(50)],
      NOW,
    );
    expect(larger.p90AgeHours).not.toBeNull();
  });

  it("handles a single-record sample without dividing by zero", () => {
    const stats = computeFreshnessStats([hoursAgo(5)], NOW);
    expect(stats.medianAgeHours).toBe(5);
    expect(stats.p25AgeHours).toBe(5);
    expect(stats.p75AgeHours).toBe(5);
    expect(stats.pctLt24h).toBe(100);
  });
});
