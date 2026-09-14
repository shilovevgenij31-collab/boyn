/**
 * Export round-trip/validity tests (Phase 7 brief §43, §61): Markdown,
 * CSV, and JSON built from a small deterministic fixture DailyReport.
 */
import { describe, expect, it } from "vitest";
import { buildDailyReport, type CandidatePost } from "@/core/report/build-daily-report.ts";
import { exportMarkdown } from "@/core/report/export-markdown.ts";
import { exportCsv } from "@/core/report/export-csv.ts";
import { exportJson } from "@/core/report/export-json.ts";
import { exportHashtagHistoryCsv } from "@/core/report/export-hashtag-history.ts";
import type { BuildDailyReportInput } from "@/core/report/build-daily-report.ts";

const NOW = new Date("2026-09-12T18:00:00.000Z");

function post(overrides: Partial<CandidatePost> & { postId: number }): CandidatePost {
  return {
    platform: "tiktok",
    externalId: `ext-${overrides.postId}`,
    canonicalUrl: `https://www.tiktok.com/@creator/video/${overrides.postId}`,
    creatorUsername: "Кириллица_créateur", // Unicode/Cyrillic on purpose (brief §39)
    caption: 'a caption with a "quote", a comma, and\na newline',
    hashtags: ["cosplay", "аниме"],
    categories: ["cosplay"],
    publishedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    views: 50_000,
    likes: 2000,
    comments: 100,
    shares: null,
    vph: 10_000,
    vphKind: "OBSERVED",
    velocityConfidence: "HIGH",
    trendScore: 80,
    risingScore: 70,
    trendState: "RISING",
    tier: "VIRAL_QUALIFIED",
    scoreComponents: { trend: [], rising: [] },
    availability: "ACTIVE",
    contentType: "video",
    ...overrides,
  };
}

function baseInput(candidatePosts: CandidatePost[]): BuildDailyReportInput {
  return {
    now: NOW,
    reportDate: "2026-09-12",
    timezone: "UTC",
    market: "global",
    scoringVersion: 1,
    candidatePosts,
    yesterdayPostIds: new Set(),
    yesterday: { viralQualified: 5, earlyBreakout: 2, postsScanned: 80 },
    collection: {
      runs: 10,
      runsFailed: 0,
      runsPartial: 0,
      postsScannedTotal: 100,
      postsScannedByPlatform: { tiktok: 70, instagram: 30 },
      uniquePosts: 90,
      newPosts: 40,
      snapshots: 120,
      recordsUsed: 100,
      estCostUsd: 1.5,
      tagsScanned: 20,
      tagsFailed: [],
    },
    partialReasons: [],
    hashtagSections: {
      breakout: [{ tag: "cosplay", platform: "tiktok", trendState: "BREAKOUT", radarPosts24h: 4, qualifiedPosts24h: 3, distinctCreators24h: 3, medianVph: 8000, radarMomentum: 0.7, relatedTags: [] }],
      rising: [],
      topByQualifiedPosts: [],
    },
    newlyTracked: ["newtag"],
    demoted: [],
    clusterEdges: [],
    tagTotalPosts: new Map(),
    tagStrength: new Map(),
  };
}

const report = buildDailyReport(baseInput([post({ postId: 1 }), post({ postId: 2, platform: "instagram", canonicalUrl: "https://www.instagram.com/p/abc/" })]));

describe("exportJson", () => {
  it("produces valid, parseable JSON preserving schema/scoring version", () => {
    const json = exportJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scoringVersion).toBe(1);
    expect(parsed.todayTop.length).toBeGreaterThan(0);
  });
});

describe("exportCsv", () => {
  it("starts with a UTF-8 BOM", () => {
    const csv = exportCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("parses into the expected row count and columns, preserving Unicode", () => {
    const csv = exportCsv(report);
    const withoutBom = csv.slice(1);
    const lines = withoutBom.trim().split("\r\n");
    const header = lines[0]!.split(",");
    expect(header).toContain("canonical_url");
    expect(header).toContain("trend_score");
    // header + N data rows
    expect(lines.length).toBe(1 + report.exportCandidates.length);
    expect(csv).toContain("аниме");
  });

  it("correctly quotes/escapes commas, quotes, and newlines in caption text", () => {
    const csv = exportCsv(report);
    // The caption contains a literal comma, a quote, and a newline — must
    // be wrapped in a quoted field with doubled internal quotes, per RFC
    // 4180 (the embedded newline stays a real newline inside the quotes).
    expect(csv).toContain('"a caption with a ""quote"", a comma, and\na newline"');
  });

  it("never turns a null metric into a literal 0", () => {
    const csv = exportCsv(report);
    // post 1's shares is null -> the shares column cell must be empty, not "0".
    const lines = csv.slice(1).trim().split("\r\n");
    const header = lines[0]!.split(",");
    const sharesIdx = header.indexOf("shares");
    const dataRow = lines[1]!;
    // naive split is fine here since this row has no embedded commas in the shares position
    const cells = dataRow.split(",");
    expect(cells[sharesIdx]).toBe("");
  });
});

describe("exportMarkdown", () => {
  const md = exportMarkdown(report);

  it("contains the original canonical URLs", () => {
    expect(md).toContain("tiktok.com/@creator/video/1");
    expect(md).toContain("instagram.com/p/abc");
  });

  it("never contains a provider/CDN URL", () => {
    expect(md).not.toMatch(/apify\.com|brightdata\.com|tiktokcdn|cdninstagram/);
  });

  it("includes the ready-to-paste analysis prompt and Radar-momentum wording, never a platform-wide claim", () => {
    expect(md).toContain("Analysis prompt");
    expect(md).toMatch(/Radar momentum|Radar posts/);
    expect(md).not.toMatch(/TikTok hashtag grew/i);
  });

  it("includes metric definitions for OBSERVED vs ESTIMATED and trend states", () => {
    expect(md).toMatch(/OBSERVED/);
    expect(md).toMatch(/ESTIMATED/);
    expect(md).toMatch(/BREAKOUT/);
  });

  it("includes Today, Still Hot, and Rising Now sections", () => {
    expect(md).toContain("Today Top");
    expect(md).toContain("Still Hot");
    expect(md).toContain("Rising Now");
  });
});

describe("exportHashtagHistoryCsv", () => {
  it("produces a valid CSV with a UTF-8 BOM and Radar-labelled columns", () => {
    const csv = exportHashtagHistoryCsv([
      { date: "2026-09-11", platform: "tiktok", market: "global", tag: "cosplay", trendState: "RISING", radarMomentum: 0.5, radarPostsSeen: 12, qualifiedPosts: 3, breakoutPosts: 1, distinctCreators: 5, medianVph: 2000, scans: 4 },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("radar_momentum");
    expect(lines[0]).not.toContain("growth_pct");
  });
});
