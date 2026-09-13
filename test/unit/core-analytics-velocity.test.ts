import { describe, expect, it } from "vitest";
import { computeVelocity } from "@/core/analytics/velocity.ts";

const publishedAt = new Date("2026-09-12T00:00:00.000Z");

describe("computeVelocity", () => {
  it("OBSERVED with one real interval (2 snapshots after publish) -> MEDIUM confidence", () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [
        { observedAt: new Date("2026-09-12T02:00:00.000Z"), views: 10_000 },
        { observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 25_000 },
      ],
    });
    expect(result.kind).toBe("OBSERVED");
    expect(result.confidence).toBe("MEDIUM");
    // last real interval: (25000-10000)/(3h) = 5000/h
    expect(result.vph).toBeCloseTo(5000, 5);
    expect(result.vphPrevious).toBeNull();
  });

  it("OBSERVED with two real intervals -> HIGH confidence, vphPrevious populated", () => {
    const now = new Date("2026-09-12T10:00:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [
        { observedAt: new Date("2026-09-12T02:00:00.000Z"), views: 5_000 },
        { observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 20_000 }, // +15000/3h = 5000/h
        { observedAt: new Date("2026-09-12T09:00:00.000Z"), views: 60_000 }, // +40000/4h = 10000/h
      ],
    });
    expect(result.kind).toBe("OBSERVED");
    expect(result.confidence).toBe("HIGH");
    expect(result.vph).toBeCloseTo(10_000, 5);
    expect(result.vphPrevious).toBeCloseTo(5_000, 5);
  });

  it("ESTIMATED fallback: only the birth interval qualifies (a single real snapshot far enough past publish)", () => {
    const now = new Date("2026-09-12T05:00:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [{ observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 24_000 }],
    });
    expect(result.kind).toBe("ESTIMATED");
    expect(result.confidence).toBe("LOW");
    expect(result.vph).toBeCloseTo(24_000 / 5, 5);
  });

  it("missing views entirely -> NONE", () => {
    const result = computeVelocity({ publishedAt, now: new Date("2026-09-12T05:00:00.000Z"), snapshots: [] });
    expect(result.kind).toBe("NONE");
    expect(result.vph).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it("missing publishedAt -> NONE, regardless of snapshots", () => {
    const result = computeVelocity({
      publishedAt: null,
      now: new Date("2026-09-12T05:00:00.000Z"),
      snapshots: [{ observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 1000 }],
    });
    expect(result.kind).toBe("NONE");
  });

  it("same-timestamp snapshot (zero elapsed) never divides by zero and falls back to raw estimate", () => {
    const now = new Date("2026-09-12T00:05:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [{ observedAt: publishedAt, views: 500 }],
    });
    expect(Number.isFinite(result.vph)).toBe(true);
    expect(result.kind).toBe("ESTIMATED");
  });

  it("a too-short interval (< 45 min) is merged forward, not treated as a real interval", () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [
        { observedAt: new Date("2026-09-12T02:00:00.000Z"), views: 10_000 },
        { observedAt: new Date("2026-09-12T02:20:00.000Z"), views: 10_500 }, // only 20 min later - merged
        { observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 25_000 },
      ],
    });
    expect(result.kind).toBe("OBSERVED");
    // The merged point is skipped entirely; the real interval spans
    // 02:00 -> 05:00 using the anchor's views (10000), not the skipped
    // point's (10500).
    expect(result.vph).toBeCloseTo((25_000 - 10_000) / 3, 5);
  });

  it("a negative view delta (provider regression) is floored to 0, never negative, and flagged", () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [
        { observedAt: new Date("2026-09-12T02:00:00.000Z"), views: 50_000 },
        { observedAt: new Date("2026-09-12T05:00:00.000Z"), views: 40_000 }, // dropped - provider anomaly
      ],
    });
    expect(result.vph).toBeGreaterThanOrEqual(0);
    expect(result.vph).toBe(0);
    expect(result.hadNegativeDeltaAnomaly).toBe(true);
  });

  it("a very young post (single snapshot minutes old) uses the minimum age floor, not an absurd rate", () => {
    const now = new Date("2026-09-12T00:10:00.000Z");
    const result = computeVelocity({
      publishedAt,
      now,
      snapshots: [{ observedAt: new Date("2026-09-12T00:10:00.000Z"), views: 50_000 }],
    });
    expect(result.kind).toBe("ESTIMATED");
    // Age is 10 min = 0.1667h, floored to 1h minimum -> 50000/h, not 300000/h.
    expect(result.vph).toBeCloseTo(50_000, 5);
  });
});
