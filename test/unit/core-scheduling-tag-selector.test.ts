import { describe, expect, it } from "vitest";
import {
  computeNextDueAt,
  selectHashtagsForDiscovery,
  tierDiscoveryIntervalHours,
  type DueHashtagCandidate,
} from "@/core/scheduling/tag-selector.ts";

const now = new Date("2026-09-12T13:00:00.000Z");

function candidate(overrides: Partial<DueHashtagCandidate> = {}): DueHashtagCandidate {
  return {
    trackedHashtagId: 1,
    hashtagId: 1,
    hashtagName: "cosplay",
    tier: "CORE",
    source: "SEED",
    trendState: "NEW",
    nextDueAt: null,
    ...overrides,
  };
}

describe("tierDiscoveryIntervalHours", () => {
  it("CORE is 48h normally, 24h when BREAKOUT or RISING", () => {
    expect(tierDiscoveryIntervalHours("CORE", "SEED", "STABLE")).toBe(48);
    expect(tierDiscoveryIntervalHours("CORE", "SEED", "BREAKOUT")).toBe(24);
    expect(tierDiscoveryIntervalHours("CORE", "SEED", "RISING")).toBe(24);
  });

  it("ACTIVE is 24h regardless of trend_state", () => {
    expect(tierDiscoveryIntervalHours("ACTIVE", "DISCOVERED", "STABLE")).toBe(24);
    expect(tierDiscoveryIntervalHours("ACTIVE", "DISCOVERED", "BREAKOUT")).toBe(24);
  });

  it("EXPLORATION is 24h", () => {
    expect(tierDiscoveryIntervalHours("EXPLORATION", "DISCOVERED", "NEW")).toBe(24);
  });

  it("DORMANT is 7d for SEED-sourced, 14d for discovered/manual", () => {
    expect(tierDiscoveryIntervalHours("DORMANT", "SEED", "NEW")).toBe(24 * 7);
    expect(tierDiscoveryIntervalHours("DORMANT", "DISCOVERED", "NEW")).toBe(24 * 14);
    expect(tierDiscoveryIntervalHours("DORMANT", "MANUAL", "NEW")).toBe(24 * 14);
  });
});

describe("computeNextDueAt", () => {
  it("adds the tier's interval in hours to now", () => {
    const result = computeNextDueAt("ACTIVE", "DISCOVERED", "STABLE", now);
    expect(result.getTime() - now.getTime()).toBe(24 * 3_600_000);
  });
});

describe("selectHashtagsForDiscovery", () => {
  it("takes core first, then active, then exploration/dormant, up to batchSize", () => {
    const core = [candidate({ trackedHashtagId: 1, tier: "CORE" }), candidate({ trackedHashtagId: 2, tier: "CORE" })];
    const active = [candidate({ trackedHashtagId: 3, tier: "ACTIVE" })];
    const explorationOrDormant = [
      candidate({ trackedHashtagId: 4, tier: "EXPLORATION" }),
      candidate({ trackedHashtagId: 5, tier: "DORMANT" }),
    ];
    const selected = selectHashtagsForDiscovery({ core, active, explorationOrDormant }, 6);
    expect(selected.map((c) => c.trackedHashtagId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rolls over unused CORE reservation into ACTIVE/EXPLORATION when CORE has fewer due than its slot allocation", () => {
    const core = [candidate({ trackedHashtagId: 1, tier: "CORE" })]; // only 1 due, reservation is 3
    const active = [candidate({ trackedHashtagId: 2, tier: "ACTIVE" }), candidate({ trackedHashtagId: 3, tier: "ACTIVE" })];
    const explorationOrDormant = [
      candidate({ trackedHashtagId: 4, tier: "EXPLORATION" }),
      candidate({ trackedHashtagId: 5, tier: "DORMANT" }),
      candidate({ trackedHashtagId: 6, tier: "DORMANT" }),
    ];
    const selected = selectHashtagsForDiscovery({ core, active, explorationOrDormant }, 6);
    // batchSize=6 total slots; core only filled 1, so the slice reaches
    // further into active/exploration to fill the remaining 5.
    expect(selected).toHaveLength(6);
    expect(selected.map((c) => c.trackedHashtagId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("truncates to batchSize even when more candidates are due than fit", () => {
    const core = Array.from({ length: 5 }, (_, i) => candidate({ trackedHashtagId: i + 1, tier: "CORE" }));
    const selected = selectHashtagsForDiscovery({ core, active: [], explorationOrDormant: [] }, 3);
    expect(selected).toHaveLength(3);
  });

  it("returns an empty array when nothing is due", () => {
    const selected = selectHashtagsForDiscovery({ core: [], active: [], explorationOrDormant: [] }, 6);
    expect(selected).toEqual([]);
  });
});
