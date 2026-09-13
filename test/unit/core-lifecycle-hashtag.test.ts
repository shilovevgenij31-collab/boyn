import { describe, expect, it } from "vitest";
import { decideTierCapEviction, evaluateHashtagLifecycle, type HashtagLifecycleState, type LifecycleEvidence } from "@/core/lifecycle/hashtag-lifecycle.ts";

const now = new Date("2026-09-12T12:00:00.000Z");
const longAgo = new Date("2026-09-01T00:00:00.000Z");

function state(overrides: Partial<HashtagLifecycleState> = {}): HashtagLifecycleState {
  return { tier: "EXPLORATION", source: "DISCOVERED", tierChangedAt: longAgo, probesInTier: 0, daysInTier: 0, ...overrides };
}

function evidence(overrides: Partial<LifecycleEvidence> = {}): LifecycleEvidence {
  return {
    qualifiedPostsInTier: 0,
    distinctCreatorsInTier: 0,
    trendState: "STABLE",
    consecutiveWeakTrendStateEvals: 0,
    consecutiveEmptyScans: 0,
    recentQualifiedPostsAnyPath: 0,
    ...overrides,
  };
}

describe("evaluateHashtagLifecycle — CORE protection", () => {
  it("CORE never transitions automatically, regardless of evidence", () => {
    const decision = evaluateHashtagLifecycle(
      state({ tier: "CORE" }),
      evidence({ consecutiveWeakTrendStateEvals: 99, consecutiveEmptyScans: 99 }),
      now,
    );
    expect(decision.action).toBe("hold");
  });
});

describe("evaluateHashtagLifecycle — hysteresis", () => {
  it("a tag that changed tier less than 24h ago holds regardless of evidence", () => {
    const recentChange = new Date(now.getTime() - 60 * 60_000); // 1h ago
    const decision = evaluateHashtagLifecycle(
      state({ tier: "EXPLORATION", tierChangedAt: recentChange }),
      evidence({ qualifiedPostsInTier: 5, distinctCreatorsInTier: 5 }),
      now,
    );
    expect(decision.action).toBe("hold");
  });
});

describe("evaluateHashtagLifecycle — EXPLORATION -> ACTIVE", () => {
  it("promotes on >=2 qualified posts from >=2 distinct creators", () => {
    const decision = evaluateHashtagLifecycle(state(), evidence({ qualifiedPostsInTier: 2, distinctCreatorsInTier: 2 }), now);
    expect(decision).toEqual({ action: "promote", toTier: "ACTIVE", reason: "exploration_criteria_met" });
  });

  it("promotes on trend_state BREAKOUT/RISING even with insufficient post/creator counts", () => {
    const decision = evaluateHashtagLifecycle(state(), evidence({ trendState: "BREAKOUT", qualifiedPostsInTier: 0 }), now);
    expect(decision.action).toBe("promote");
  });

  it("does not promote on a single viral outlier from one creator", () => {
    const decision = evaluateHashtagLifecycle(state(), evidence({ qualifiedPostsInTier: 1, distinctCreatorsInTier: 1 }), now);
    expect(decision.action).toBe("hold");
  });
});

describe("evaluateHashtagLifecycle — EXPLORATION -> DORMANT", () => {
  it("demotes after enough probes/days without meeting promotion criteria", () => {
    const decision = evaluateHashtagLifecycle(state({ probesInTier: 2, daysInTier: 4 }), evidence(), now);
    expect(decision).toEqual({ action: "demote", toTier: "DORMANT", reason: "exploration_probes_exhausted" });
  });

  it("holds (still probing) before the probe/day budget is exhausted", () => {
    const decision = evaluateHashtagLifecycle(state({ probesInTier: 1, daysInTier: 1 }), evidence(), now);
    expect(decision.action).toBe("hold");
  });
});

describe("evaluateHashtagLifecycle — ACTIVE -> DORMANT", () => {
  it("demotes after consecutive weak trend-state evaluations", () => {
    const decision = evaluateHashtagLifecycle(state({ tier: "ACTIVE" }), evidence({ consecutiveWeakTrendStateEvals: 2 }), now);
    expect(decision).toEqual({ action: "demote", toTier: "DORMANT", reason: "consecutive_weak_trend_state" });
  });

  it("demotes after consecutive zero-viral scans", () => {
    const decision = evaluateHashtagLifecycle(state({ tier: "ACTIVE" }), evidence({ consecutiveEmptyScans: 3 }), now);
    expect(decision).toEqual({ action: "demote", toTier: "DORMANT", reason: "consecutive_zero_viral_scans" });
  });

  it("holds while still performing", () => {
    const decision = evaluateHashtagLifecycle(state({ tier: "ACTIVE" }), evidence({ trendState: "ACTIVE" }), now);
    expect(decision.action).toBe("hold");
  });
});

describe("evaluateHashtagLifecycle — DORMANT passive revival", () => {
  it("revives to EXPLORATION when enough qualified posts appear via other discovery paths", () => {
    const decision = evaluateHashtagLifecycle(state({ tier: "DORMANT" }), evidence({ recentQualifiedPostsAnyPath: 3 }), now);
    expect(decision).toEqual({ action: "promote", toTier: "EXPLORATION", reason: "passive_revival" });
  });

  it("does not revive on weak/insufficient evidence", () => {
    const decision = evaluateHashtagLifecycle(state({ tier: "DORMANT" }), evidence({ recentQualifiedPostsAnyPath: 1 }), now);
    expect(decision.action).toBe("hold");
  });
});

describe("decideTierCapEviction", () => {
  it("admits freely when the pool is under its cap", () => {
    expect(decideTierCapEviction({ currentSize: 3, cap: 8, incomingPriority: 1, weakestCurrentPriority: null })).toEqual({
      admit: true,
      evictWeakest: false,
    });
  });

  it("a stronger candidate evicts the current weakest member when the pool is full", () => {
    expect(decideTierCapEviction({ currentSize: 8, cap: 8, incomingPriority: 10, weakestCurrentPriority: 5 })).toEqual({
      admit: true,
      evictWeakest: true,
    });
  });

  it("a weaker candidate is held back (queued), not admitted, when the pool is full", () => {
    expect(decideTierCapEviction({ currentSize: 8, cap: 8, incomingPriority: 2, weakestCurrentPriority: 5 })).toEqual({
      admit: false,
      evictWeakest: false,
    });
  });
});
