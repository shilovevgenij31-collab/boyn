import { describe, expect, it } from "vitest";
import { computeRelevance } from "../../scripts/provider-spike/relevance.ts";

describe("computeRelevance", () => {
  it("matches via caption substring", () => {
    const result = computeRelevance(["my ps5 setup is insane"], [null], ["ps5"]);
    expect(result.matched).toBe(1);
    expect(result.pct).toBe(100);
  });

  it("matches via hashtag membership, case-insensitively and ignoring leading #", () => {
    const result = computeRelevance(["no keyword here"], [["PS5", "gaming"]], ["ps5"]);
    expect(result.matched).toBe(1);
  });

  it("does not match unrelated content", () => {
    const result = computeRelevance(["my cat is cute"], [["catsoftiktok"]], ["ps5", "gaming", "cosplay"]);
    expect(result.matched).toBe(0);
    expect(result.pct).toBe(0);
    expect(result.mismatchExamples).toEqual(["my cat is cute"]);
  });

  it("matches if ANY of multiple query terms is present", () => {
    const result = computeRelevance(["cosplay time!"], [null], ["ps5", "gaming", "cosplay"]);
    expect(result.matched).toBe(1);
  });

  it("computes pct correctly across a mixed batch", () => {
    const result = computeRelevance(
      ["gaming setup", "random unrelated post", "ps5 unboxing"],
      [null, null, null],
      ["gaming", "ps5"],
    );
    expect(result.total).toBe(3);
    expect(result.matched).toBe(2);
    expect(result.pct).toBe(66.7);
  });

  it("caps mismatch examples at maxExamples", () => {
    const captions = Array(10).fill("totally unrelated content");
    const result = computeRelevance(captions, Array(10).fill(null), ["ps5"], 3);
    expect(result.matched).toBe(0);
    expect(result.mismatchExamples).toHaveLength(3);
  });

  it("handles a null caption without crashing, labels it in the example", () => {
    const result = computeRelevance([null], [["unrelated"]], ["ps5"]);
    expect(result.matched).toBe(0);
    expect(result.mismatchExamples[0]).toBe("(no caption)");
  });

  it("returns 0/0 pct=0 for an empty record set", () => {
    const result = computeRelevance([], [], ["ps5"]);
    expect(result).toEqual({ total: 0, matched: 0, pct: 0, mismatchExamples: [] });
  });
});
