import { describe, expect, it } from "vitest";
import { buildReportMarkdown } from "../../scripts/provider-spike/report.ts";
import type { CombinationResult, SpikeResults } from "../../scripts/provider-spike/types.ts";

function blocked(provider: "brightdata" | "apify", platform: "tiktok" | "instagram"): CombinationResult {
  return {
    provider,
    platform,
    outcome: "BLOCKED",
    blockedReason: `${provider.toUpperCase()}_API_TOKEN is not set`,
    errorMessage: null,
    hashtagsQueried: [],
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "not run",
    asyncLatency: null,
    refreshByUrl: null,
    edgeCaseNotes: [],
    cost: null,
    fixturesSaved: 0,
  };
}

describe("buildReportMarkdown", () => {
  it("renders a fully-blocked run honestly, with no fabricated data", () => {
    const results: SpikeResults = {
      executedAt: "2026-09-12T00:00:00.000Z",
      hashtagsUsed: ["cosplay", "gaming", "ps5"],
      resultsPerHashtag: 20,
      combinations: [
        blocked("brightdata", "tiktok"),
        blocked("brightdata", "instagram"),
        blocked("apify", "tiktok"),
        blocked("apify", "instagram"),
      ],
    };
    const md = buildReportMarkdown(results);

    expect(md).toContain("Tested: 0/4");
    expect(md).toContain("Blocked (missing credentials): 4/4");
    expect(md).toContain("BRIGHTDATA_API_TOKEN is not set");
    expect(md).toContain("APIFY_API_TOKEN is not set");
    // Blocked rows must show placeholder dashes, never a fabricated percentage value.
    expect(md).toContain("| brightdata / tiktok | BLOCKED | — | — | — | — | — | — | — |");
    expect(md).not.toMatch(/\d+%/);
  });

  it("renders a TESTED combination's freshness numbers and findings", () => {
    const tested: CombinationResult = {
      provider: "brightdata",
      platform: "tiktok",
      outcome: "TESTED",
      blockedReason: null,
      errorMessage: null,
      hashtagsQueried: ["cosplay", "gaming", "ps5"],
      recordsDelivered: 42,
      freshness: {
        sampleSize: 42,
        withTimestamp: 42,
        medianAgeHours: 18.5,
        p25AgeHours: 6,
        p75AgeHours: 40,
        p90AgeHours: 60,
        minAgeHours: 1,
        maxAgeHours: 90,
        pctLt6h: 15,
        pctLt12h: 30,
        pctLt24h: 55,
        pctLt48h: 80,
        pctLt72h: 95,
      },
      fieldCoverage: [{ field: "views", present: 40, total: 42, pct: 95.2 }],
      viewsMetricNote: "consistently `views`",
      urlFinding: {
        sampleField: "url",
        looksCanonical: true,
        hostSeen: "tiktok.com",
        example: "https://www.tiktok.com/@user/video/123",
        note: "resolves to the platform's own domain",
      },
      idFinding: { candidateField: "post_id", stable: "UNKNOWN", note: "present" },
      multiQueryAttribution: "AMBIGUOUS",
      multiQueryNote: "inferred from content",
      asyncLatency: { submittedAt: 0, readyAt: 12000, totalLatencyMs: 12000, pollCount: 3, finalStatus: "ready" },
      refreshByUrl: {
        verdict: "SUPPORTED",
        originalExternalId: "123",
        refreshedExternalId: "123",
        sameExternalId: true,
        originalViews: 1000,
        refreshedViews: 1200,
        latencyMs: 8000,
        note: "one record returned",
      },
      edgeCaseNotes: ["2 duplicate id(s) across the combined multi-hashtag result set"],
      cost: {
        recordsRequested: 60,
        recordsDelivered: 42,
        providerReportedUsage: null,
        estimatedUsd: 0.063,
        estimateBasis: "documented PAYG rate",
      },
      fixturesSaved: 5,
    };
    const results: SpikeResults = {
      executedAt: "2026-09-12T00:00:00.000Z",
      hashtagsUsed: ["cosplay", "gaming", "ps5"],
      resultsPerHashtag: 20,
      combinations: [tested],
    };
    const md = buildReportMarkdown(results);

    expect(md).toContain("Tested: 1/1");
    expect(md).toContain("18.5h"); // median age
    expect(md).toContain("55%"); // pctLt24h
    expect(md).toContain("tiktok.com");
    expect(md).toContain("SUPPORTED");
    expect(md).toContain("duplicate id(s)");
    expect(md).toContain("Fixtures saved:** 5");
  });
});
