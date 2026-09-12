import { describe, expect, it } from "vitest";
import { buildPhase1BSection, upsertPhase1BSection } from "../../scripts/provider-spike/report-1b.ts";
import type { Phase1BCandidateResult, Phase1BResults } from "../../scripts/provider-spike/types-1b.ts";

function blockedCandidate(label: string): Phase1BCandidateResult {
  return {
    label,
    provider: "brightdata",
    outcome: "BLOCKED",
    blockedReason: "no credentials",
    errorMessage: null,
    smokeTest: null,
    queryTermsUsed: [],
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    relevance: null,
    duplicateIdCount: 0,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "",
    asyncLatency: null,
    cost: null,
    fixturesSaved: 0,
    edgeCaseNotes: [],
  };
}

describe("buildPhase1BSection", () => {
  it("includes the header, query terms, and each candidate label", () => {
    const results: Phase1BResults = {
      executedAt: "2026-09-13T00:00:00.000Z",
      queryTerms: ["cosplay", "gaming", "ps5"],
      resultsPerQuery: 20,
      candidates: [blockedCandidate("Bright Data — discover_by=keyword")],
    };
    const md = buildPhase1BSection(results);
    expect(md).toContain("Phase 1B — TikTok Discovery Rescue");
    expect(md).toContain("cosplay, gaming, ps5");
    expect(md).toContain("Bright Data — discover_by=keyword");
    expect(md).toContain("BLOCKED");
  });
});

describe("upsertPhase1BSection", () => {
  const section = "<!-- PHASE-1B-START (auto-generated, do not edit by hand) -->\nNEW CONTENT\n<!-- PHASE-1B-END -->";

  it("appends the section to a report with no prior Phase 1B content, preserving it", () => {
    const original = "# Provider Spike\n\nOriginal Phase 1 content here.\n";
    const result = upsertPhase1BSection(original, section);
    expect(result).toContain("Original Phase 1 content here.");
    expect(result).toContain("NEW CONTENT");
  });

  it("replaces only the Phase 1B section on re-run, preserving everything else", () => {
    const original =
      "# Provider Spike\n\nOriginal Phase 1 content.\n\n---\n\n" +
      "<!-- PHASE-1B-START (auto-generated, do not edit by hand) -->\nOLD CONTENT\n<!-- PHASE-1B-END -->\n";
    const result = upsertPhase1BSection(original, section);
    expect(result).toContain("Original Phase 1 content.");
    expect(result).toContain("NEW CONTENT");
    expect(result).not.toContain("OLD CONTENT");
  });
});
