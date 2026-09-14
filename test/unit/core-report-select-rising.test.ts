import { describe, expect, it } from "vitest";
import { selectRisingNow } from "@/core/report/select-rising.ts";

describe("selectRisingNow", () => {
  it("sorts by risingScore descending", () => {
    const result = selectRisingNow(
      [
        { postId: 1, risingScore: 40, vph: 100, publishedAtMs: 1 },
        { postId: 2, risingScore: 90, vph: 100, publishedAtMs: 1 },
        { postId: 3, risingScore: 60, vph: 100, publishedAtMs: 1 },
      ],
      10,
    );
    expect(result.map((c) => c.postId)).toEqual([2, 3, 1]);
  });

  it("caps at max", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({ postId: i, risingScore: i, vph: 0, publishedAtMs: 0 }));
    expect(selectRisingNow(candidates, 10)).toHaveLength(10);
  });

  it("a huge flat historical hit (low risingScore) never dominates over a genuinely rising post", () => {
    const result = selectRisingNow(
      [
        { postId: 1, risingScore: 5, vph: 10, publishedAtMs: 1 }, // huge flat hit, low current signal
        { postId: 2, risingScore: 85, vph: 15000, publishedAtMs: 2 }, // fresh breakout
      ],
      10,
    );
    expect(result[0]?.postId).toBe(2);
  });

  it("ties break by vph then publishedAtMs then postId", () => {
    const result = selectRisingNow(
      [
        { postId: 3, risingScore: 50, vph: 100, publishedAtMs: 100 },
        { postId: 1, risingScore: 50, vph: 200, publishedAtMs: 100 },
      ],
      10,
    );
    expect(result.map((c) => c.postId)).toEqual([1, 3]);
  });
});
