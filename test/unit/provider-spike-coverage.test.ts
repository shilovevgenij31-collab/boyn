import { describe, expect, it } from "vitest";
import { computeFieldCoverage } from "../../scripts/provider-spike/coverage.ts";

describe("computeFieldCoverage", () => {
  it("computes present/total/pct per field, treating null/undefined/empty as absent", () => {
    const records = [
      { views: 100, likes: null, caption: "hi" },
      { views: 200, likes: 5, caption: "" },
      { views: undefined, likes: 3, caption: "yo" },
    ];
    const coverage = computeFieldCoverage(records, ["views", "likes", "caption"]);

    expect(coverage).toEqual([
      { field: "views", present: 2, total: 3, pct: 66.7 },
      { field: "likes", present: 2, total: 3, pct: 66.7 },
      { field: "caption", present: 2, total: 3, pct: 66.7 },
    ]);
  });

  it("never coerces a missing field to a present zero value", () => {
    const records = [{ shares: 0 }, {}];
    const coverage = computeFieldCoverage(records, ["shares"]);
    // shares: 0 IS present (a real zero); the second record has no field at all.
    expect(coverage[0]).toEqual({ field: "shares", present: 1, total: 2, pct: 50 });
  });

  it("supports dotted paths into nested objects", () => {
    const records = [
      { authorMeta: { fans: 1000 } },
      { authorMeta: {} },
      { authorMeta: null },
      {},
    ];
    const coverage = computeFieldCoverage(records, ["authorMeta.fans"]);
    expect(coverage[0]).toEqual({ field: "authorMeta.fans", present: 1, total: 4, pct: 25 });
  });

  it("returns 0% (not NaN) for an empty record set", () => {
    const coverage = computeFieldCoverage([], ["views"]);
    expect(coverage[0]).toEqual({ field: "views", present: 0, total: 0, pct: 0 });
  });

  it("treats an empty array value as absent", () => {
    const records = [{ hashtags: [] }, { hashtags: ["a", "b"] }];
    const coverage = computeFieldCoverage(records, ["hashtags"]);
    expect(coverage[0]).toEqual({ field: "hashtags", present: 1, total: 2, pct: 50 });
  });
});
