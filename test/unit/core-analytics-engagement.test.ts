import { describe, expect, it } from "vitest";
import { computeEngagementRatios } from "@/core/analytics/engagement.ts";

describe("computeEngagementRatios", () => {
  it("computes all three ratios when full metrics are available", () => {
    const result = computeEngagementRatios({ views: 10_000, likes: 500, comments: 50, shares: 20 });
    expect(result.likeRatio).toBeCloseTo(501 / 10_001, 6);
    expect(result.commentRatio).toBeCloseTo(51 / 10_001, 6);
    expect(result.shareRatio).toBeCloseTo(21 / 10_001, 6);
  });

  it("missing shares (Instagram) -> null, not 0", () => {
    const result = computeEngagementRatios({ views: 10_000, likes: 500, comments: 50, shares: null });
    expect(result.shareRatio).toBeNull();
    expect(result.likeRatio).not.toBeNull();
    expect(result.commentRatio).not.toBeNull();
  });

  it("missing likes -> null for that ratio only", () => {
    const result = computeEngagementRatios({ views: 10_000, likes: null, comments: 50, shares: 20 });
    expect(result.likeRatio).toBeNull();
    expect(result.commentRatio).not.toBeNull();
    expect(result.shareRatio).not.toBeNull();
  });

  it("zero views is a valid edge case, not a crash — ratios use +1 smoothing", () => {
    const result = computeEngagementRatios({ views: 0, likes: 5, comments: 1, shares: 0 });
    expect(result.likeRatio).toBeCloseTo(6 / 1, 6);
    expect(Number.isFinite(result.likeRatio!)).toBe(true);
  });

  it("missing views -> every ratio is null", () => {
    const result = computeEngagementRatios({ views: null, likes: 5, comments: 1, shares: 0 });
    expect(result.likeRatio).toBeNull();
    expect(result.commentRatio).toBeNull();
    expect(result.shareRatio).toBeNull();
  });
});
