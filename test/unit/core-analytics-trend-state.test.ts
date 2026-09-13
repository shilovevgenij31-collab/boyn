import { describe, expect, it } from "vitest";
import { applyTrendStateHysteresis, deriveHashtagTrendState, derivePostTrendState } from "@/core/analytics/trend-state.ts";

describe("deriveHashtagTrendState", () => {
  const base = { v24: 0, c24: 0, w24: 0, b7: 0, g: 0, historyDays: 10 };

  it("BREAKOUT: v24>=3, c24>=3, g>=1.3", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 3, c24: 3, g: 1.5 })).toBe("BREAKOUT");
  });

  it("RISING: v24>=2, c24>=2, g>=0.5 (but under breakout bar)", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 2, c24: 2, g: 0.6 })).toBe("RISING");
  });

  it("FALLING: b7>=1.5 and g<=-0.6", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 0, b7: 2, g: -0.8 })).toBe("FALLING");
  });

  it("ACTIVE: v24>=2 without clearing rising's creator/growth bar", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 2, c24: 1, g: 0.1 })).toBe("ACTIVE");
  });

  it("STABLE: v24>=1 or w24>=3", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 1 })).toBe("STABLE");
    expect(deriveHashtagTrendState({ ...base, w24: 3 })).toBe("STABLE");
  });

  it("DEAD: fallthrough when nothing else matches", () => {
    expect(deriveHashtagTrendState({ ...base, v24: 0, w24: 0, b7: 0, g: 0 })).toBe("DEAD");
  });

  it("NEW: less than 2 days of history and not clearing the breakout bar", () => {
    expect(deriveHashtagTrendState({ ...base, historyDays: 1, v24: 1 })).toBe("NEW");
  });

  it("a NEW-eligible tag that ALSO clears the breakout bar reports BREAKOUT, not NEW", () => {
    expect(deriveHashtagTrendState({ ...base, historyDays: 1, v24: 3, c24: 3, g: 1.5 })).toBe("BREAKOUT");
  });
});

describe("derivePostTrendState", () => {
  it("BREAKOUT: young and high rising score", () => {
    expect(derivePostTrendState({ ageHours: 3, trendScore: 60, risingScore: 80, acceleration: 1, vph: 10_000 })).toBe("BREAKOUT");
  });

  it("RISING: high rising score regardless of age", () => {
    expect(derivePostTrendState({ ageHours: 40, trendScore: 50, risingScore: 60, acceleration: 0, vph: 5000 })).toBe("RISING");
  });

  it("FALLING: negative acceleration with still-decent trend score", () => {
    expect(derivePostTrendState({ ageHours: 30, trendScore: 40, risingScore: 20, acceleration: -1, vph: 1000 })).toBe("FALLING");
  });

  it("ACTIVE: strong trend score, no acceleration signal", () => {
    expect(derivePostTrendState({ ageHours: 30, trendScore: 60, risingScore: 20, acceleration: null, vph: 3000 })).toBe("ACTIVE");
  });

  it("STABLE: modest trend score", () => {
    expect(derivePostTrendState({ ageHours: 30, trendScore: 25, risingScore: 10, acceleration: null, vph: 500 })).toBe("STABLE");
  });

  it("DEAD: old post with negligible vph", () => {
    expect(derivePostTrendState({ ageHours: 100, trendScore: 5, risingScore: 2, acceleration: null, vph: 10 })).toBe("DEAD");
  });

  it("never derives state from TrendScore alone when RisingScore signals BREAKOUT/RISING", () => {
    // Low trend score but very high rising score (a small, brand-new post exploding) still reports RISING.
    expect(derivePostTrendState({ ageHours: 30, trendScore: 10, risingScore: 50, acceleration: null, vph: 2000 })).toBe("RISING");
  });
});

describe("applyTrendStateHysteresis", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");

  it("no previous state -> candidate applies immediately", () => {
    expect(applyTrendStateHysteresis(null, "RISING", now, 3)).toBe("RISING");
  });

  it("same state -> unchanged", () => {
    expect(applyTrendStateHysteresis({ state: "ACTIVE", since: now }, "ACTIVE", now, 3)).toBe("ACTIVE");
  });

  it("an upgrade applies immediately even within the hysteresis window", () => {
    const since = new Date(now.getTime() - 30 * 60_000); // 30 min ago
    expect(applyTrendStateHysteresis({ state: "STABLE", since }, "RISING", now, 3)).toBe("RISING");
  });

  it("a downgrade within the hysteresis window is suppressed (holds the previous state)", () => {
    const since = new Date(now.getTime() - 30 * 60_000);
    expect(applyTrendStateHysteresis({ state: "RISING", since }, "STABLE", now, 3)).toBe("RISING");
  });

  it("a downgrade once the hysteresis window has elapsed applies normally", () => {
    const since = new Date(now.getTime() - 4 * 3_600_000); // 4h ago, window is 3h
    expect(applyTrendStateHysteresis({ state: "RISING", since }, "STABLE", now, 3)).toBe("STABLE");
  });
});
