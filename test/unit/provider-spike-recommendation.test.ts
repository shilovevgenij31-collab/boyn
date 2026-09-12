import { describe, expect, it } from "vitest";
import { buildPlatformRecommendation, rateFreshness } from "../../scripts/provider-spike/recommendation.ts";
import type { CombinationResult } from "../../scripts/provider-spike/types.ts";
import type { FreshnessStats } from "../../scripts/provider-spike/freshness.ts";

function freshness(pctLt24h: number | null, overrides: Partial<FreshnessStats> = {}): FreshnessStats {
  return {
    sampleSize: 60,
    withTimestamp: 60,
    medianAgeHours: 10,
    p25AgeHours: 5,
    p75AgeHours: 20,
    p90AgeHours: 30,
    minAgeHours: 1,
    maxAgeHours: 40,
    pctLt6h: 10,
    pctLt12h: 20,
    pctLt24h,
    pctLt48h: 50,
    pctLt72h: 60,
    ...overrides,
  };
}

function tested(
  provider: "brightdata" | "apify",
  platform: "tiktok" | "instagram",
  pctLt24h: number | null,
  refreshVerdict: CombinationResult["refreshByUrl"] = null,
): CombinationResult {
  return {
    provider,
    platform,
    outcome: "TESTED",
    blockedReason: null,
    errorMessage: null,
    hashtagsQueried: ["cosplay", "gaming", "ps5"],
    recordsDelivered: 60,
    freshness: freshness(pctLt24h),
    fieldCoverage: [],
    viewsMetricNote: null,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "SUPPORTED",
    multiQueryNote: "",
    asyncLatency: null,
    refreshByUrl: refreshVerdict,
    edgeCaseNotes: [],
    cost: null,
    fixturesSaved: 5,
  };
}

function blocked(provider: "brightdata" | "apify", platform: "tiktok" | "instagram", reason: string): CombinationResult {
  return {
    provider,
    platform,
    outcome: "BLOCKED",
    blockedReason: reason,
    errorMessage: null,
    hashtagsQueried: [],
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "",
    asyncLatency: null,
    refreshByUrl: null,
    edgeCaseNotes: [],
    cost: null,
    fixturesSaved: 0,
  };
}

function errored(provider: "brightdata" | "apify", platform: "tiktok" | "instagram", message: string): CombinationResult {
  return {
    ...blocked(provider, platform, ""),
    outcome: "ERROR",
    blockedReason: null,
    errorMessage: message,
  };
}

describe("rateFreshness", () => {
  it("rates >=40% <24h as GOOD", () => {
    expect(rateFreshness(freshness(40))).toBe("GOOD");
    expect(rateFreshness(freshness(73.3))).toBe("GOOD");
  });
  it("rates 15-39% <24h as PARTIAL", () => {
    expect(rateFreshness(freshness(15))).toBe("PARTIAL");
    expect(rateFreshness(freshness(39))).toBe("PARTIAL");
  });
  it("rates <15% <24h as POOR", () => {
    expect(rateFreshness(freshness(14.9))).toBe("POOR");
    expect(rateFreshness(freshness(3.3))).toBe("POOR");
    expect(rateFreshness(freshness(0))).toBe("POOR");
  });
  it("rates null/no-timestamp data as UNKNOWN, never fabricating a rating", () => {
    expect(rateFreshness(null)).toBe("UNKNOWN");
    expect(rateFreshness(freshness(null))).toBe("UNKNOWN");
    expect(rateFreshness(freshness(50, { withTimestamp: 0 }))).toBe("UNKNOWN");
  });
});

describe("buildPlatformRecommendation", () => {
  it("real Phase 1 case: TikTok — only Apify tested, POOR freshness, BrightData errored (account) => FAILED/NO", () => {
    const combos = [
      tested("apify", "tiktok", 3.3, { verdict: "SUPPORTED", originalExternalId: "1", refreshedExternalId: "1", sameExternalId: true, originalViews: 1, refreshedViews: 1, latencyMs: 1, note: "" }),
      errored("brightdata", "tiktok", 'status=400 body="Customer is not active"'),
    ];
    const rec = buildPlatformRecommendation("tiktok", combos);
    expect(rec.gate).toBe("FAILED");
    expect(rec.productFit).toBe("NO");
    expect(rec.primaryDiscovery).toBe("neither");
    // Refresh can still be recommended even though discovery is poor.
    expect(rec.refresh).toBe("apify");
  });

  it("real Phase 1 case: Instagram — Apify tested GOOD, BrightData not attempted => PASSED/YES, primary apify", () => {
    const combos = [
      tested("apify", "instagram", 73.3, { verdict: "NOT_SUPPORTED", originalExternalId: "1", refreshedExternalId: null, sameExternalId: null, originalViews: 1, refreshedViews: null, latencyMs: null, note: "" }),
      blocked("brightdata", "instagram", "no verified Instagram hashtag-discovery endpoint on this account"),
    ];
    const rec = buildPlatformRecommendation("instagram", combos);
    expect(rec.gate).toBe("PASSED");
    expect(rec.productFit).toBe("YES");
    expect(rec.primaryDiscovery).toBe("apify");
    expect(rec.fallback).toBe("INCONCLUSIVE");
    expect(rec.refresh).toBe("neither");
  });

  it("returns BLOCKED gate / UNKNOWN product fit when nothing was tested", () => {
    const combos = [
      blocked("brightdata", "tiktok", "BRIGHTDATA_API_TOKEN is not set"),
      blocked("apify", "tiktok", "APIFY_API_TOKEN is not set"),
    ];
    const rec = buildPlatformRecommendation("tiktok", combos);
    expect(rec.gate).toBe("BLOCKED");
    expect(rec.productFit).toBe("UNKNOWN");
    expect(rec.primaryDiscovery).toBe("INCONCLUSIVE");
  });

  it("picks the better of two tested combos as primary, names the other as fallback when both pass", () => {
    const combos = [tested("apify", "tiktok", 50), tested("brightdata", "tiktok", 30)];
    const rec = buildPlatformRecommendation("tiktok", combos);
    expect(rec.primaryDiscovery).toBe("apify");
    expect(rec.fallback).toBe("brightdata");
    expect(rec.productFit).toBe("YES");
  });

  it("marks fallback POOR-rated even-though-tested as not a real fallback", () => {
    const combos = [tested("apify", "tiktok", 50), tested("brightdata", "tiktok", 5)];
    const rec = buildPlatformRecommendation("tiktok", combos);
    expect(rec.primaryDiscovery).toBe("apify");
    expect(rec.fallback).toBe("neither");
  });

  it("never marks a PASSED gate for a platform where nothing was actually tested", () => {
    const combos = [errored("apify", "tiktok", "boom"), errored("brightdata", "tiktok", "boom")];
    const rec = buildPlatformRecommendation("tiktok", combos);
    expect(rec.gate).not.toBe("PASSED");
  });
});
