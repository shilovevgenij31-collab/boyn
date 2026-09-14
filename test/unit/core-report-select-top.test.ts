import { describe, expect, it } from "vitest";
import { selectTodayTop, type TopCandidate } from "@/core/report/select-top.ts";

const CONFIG = { max: 30, maxPerCreator: 2, platformFloor: 8 };

function make(overrides: Partial<TopCandidate> & { postId: number }): TopCandidate {
  return {
    platform: "tiktok",
    creatorKey: `creator-${overrides.postId}`,
    trendScore: 50,
    risingScore: 50,
    vph: 1000,
    views: 10_000,
    publishedAtMs: Date.now(),
    ...overrides,
  };
}

describe("selectTodayTop", () => {
  it("A: both platforms have >8 available -> each gets at least the floor", () => {
    const tiktok = Array.from({ length: 30 }, (_, i) => make({ postId: i, platform: "tiktok", creatorKey: `tt-${i}`, trendScore: 100 - i }));
    const instagram = Array.from({ length: 20 }, (_, i) => make({ postId: 1000 + i, platform: "instagram", creatorKey: `ig-${i}`, trendScore: 90 - i }));
    const selected = selectTodayTop([...tiktok, ...instagram], CONFIG);

    expect(selected).toHaveLength(30);
    expect(selected.filter((c) => c.platform === "tiktok").length).toBeGreaterThanOrEqual(8);
    expect(selected.filter((c) => c.platform === "instagram").length).toBeGreaterThanOrEqual(8);
  });

  it("B: one platform has fewer than the floor -> no stale padding, just takes what's available", () => {
    const tiktok = Array.from({ length: 30 }, (_, i) => make({ postId: i, platform: "tiktok", creatorKey: `tt-${i}`, trendScore: 100 - i }));
    const instagram = Array.from({ length: 3 }, (_, i) => make({ postId: 1000 + i, platform: "instagram", creatorKey: `ig-${i}`, trendScore: 90 - i }));
    const selected = selectTodayTop([...tiktok, ...instagram], CONFIG);

    expect(selected).toHaveLength(30);
    const igCount = selected.filter((c) => c.platform === "instagram").length;
    expect(igCount).toBe(3); // exactly what was available, never padded
    expect(selected.filter((c) => c.platform === "tiktok").length).toBe(27);
  });

  it("C: one platform has zero candidates -> the other platform fills all slots, no crash", () => {
    const tiktok = Array.from({ length: 30 }, (_, i) => make({ postId: i, platform: "tiktok", creatorKey: `tt-${i}`, trendScore: 100 - i }));
    const selected = selectTodayTop(tiktok, CONFIG);
    expect(selected).toHaveLength(30);
    expect(selected.every((c) => c.platform === "tiktok")).toBe(true);
  });

  it("D: creator cap makes the floor mathematically impossible -> best-effort, no violation, no crash", () => {
    // Instagram has 10 candidates but they belong to only 2 creators (cap 2 each) -> max 4 admissible from IG.
    const instagram = Array.from({ length: 10 }, (_, i) => make({ postId: 1000 + i, platform: "instagram", creatorKey: `ig-${i % 2}`, trendScore: 90 - i }));
    const tiktok = Array.from({ length: 30 }, (_, i) => make({ postId: i, platform: "tiktok", creatorKey: `tt-${i}`, trendScore: 100 - i }));
    const selected = selectTodayTop([...tiktok, ...instagram], CONFIG);

    expect(selected).toHaveLength(30);
    const igSelected = selected.filter((c) => c.platform === "instagram");
    expect(igSelected.length).toBeLessThanOrEqual(4); // 2 creators x cap 2
    // Creator cap is respected globally.
    const creatorCounts = new Map<string, number>();
    for (const c of selected) creatorCounts.set(c.creatorKey, (creatorCounts.get(c.creatorKey) ?? 0) + 1);
    for (const count of creatorCounts.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it("fewer than max total candidates -> returns everything valid, no padding", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => make({ postId: i, creatorKey: `c-${i}` }));
    const selected = selectTodayTop(candidates, CONFIG);
    expect(selected).toHaveLength(5);
  });

  it("never duplicates a post", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => make({ postId: i, creatorKey: `c-${i}`, platform: i % 2 === 0 ? "tiktok" : "instagram" }));
    const selected = selectTodayTop(candidates, CONFIG);
    const ids = selected.map((c) => c.postId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("enforces the creator cap even within a single platform's abundant candidates", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => make({ postId: i, creatorKey: "same-creator", trendScore: 100 - i }));
    const selected = selectTodayTop(candidates, CONFIG);
    expect(selected).toHaveLength(2);
  });

  it("final order is sorted by TrendScore descending with deterministic tie-breakers", () => {
    const candidates = [
      make({ postId: 1, creatorKey: "a", trendScore: 50, risingScore: 10 }),
      make({ postId: 2, creatorKey: "b", trendScore: 80, risingScore: 5 }),
      make({ postId: 3, creatorKey: "c", trendScore: 50, risingScore: 20 }),
    ];
    const selected = selectTodayTop(candidates, CONFIG);
    expect(selected.map((c) => c.postId)).toEqual([2, 3, 1]); // 80 first, then tie broken by risingScore
  });

  it("is fully deterministic when every field ties (falls back to ascending postId)", () => {
    const candidates = [
      make({ postId: 5, creatorKey: "a" }),
      make({ postId: 2, creatorKey: "b" }),
      make({ postId: 8, creatorKey: "c" }),
    ];
    const selected = selectTodayTop(candidates, CONFIG);
    expect(selected.map((c) => c.postId)).toEqual([2, 5, 8]);
  });
});
