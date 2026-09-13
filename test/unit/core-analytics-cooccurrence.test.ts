import { describe, expect, it } from "vitest";
import { generateCooccurrencePairs } from "@/core/analytics/cooccurrence.ts";

describe("generateCooccurrencePairs", () => {
  it("produces canonically-ordered pairs (tagA < tagB)", () => {
    const pairs = generateCooccurrencePairs(["zeta", "alpha"], new Set());
    expect(pairs).toEqual([{ tagA: "alpha", tagB: "zeta" }]);
  });

  it("generates all unordered pairs for 3+ tags without duplicates", () => {
    const pairs = generateCooccurrencePairs(["a", "b", "c"], new Set());
    expect(pairs).toHaveLength(3);
    const keys = pairs.map((p) => `${p.tagA}:${p.tagB}`).sort();
    expect(keys).toEqual(["a:b", "a:c", "b:c"]);
  });

  it("does not count the same pair twice for one post (duplicate tag names deduplicated first)", () => {
    const pairs = generateCooccurrencePairs(["a", "b", "a", "b"], new Set());
    expect(pairs).toEqual([{ tagA: "a", tagB: "b" }]);
  });

  it("excludes generic tags from pair generation", () => {
    const pairs = generateCooccurrencePairs(["cosplay", "fyp", "viral"], new Set(["fyp", "viral"]));
    expect(pairs).toEqual([]);
  });

  it("caps the number of tags considered per post (pathological tag count guard)", () => {
    const manyTags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const pairs = generateCooccurrencePairs(manyTags, new Set(), 5);
    // C(5,2) = 10, not C(50,2) = 1225
    expect(pairs).toHaveLength(10);
  });

  it("a single tag (or fewer) produces no pairs", () => {
    expect(generateCooccurrencePairs(["solo"], new Set())).toEqual([]);
    expect(generateCooccurrencePairs([], new Set())).toEqual([]);
  });
});
