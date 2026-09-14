/**
 * Golden scenario + exact-boundary tests for buildDailyReport (Phase 7
 * brief §57-58).
 */
import { describe, expect, it } from "vitest";
import { buildDailyReport, type BuildDailyReportInput, type CandidatePost } from "@/core/report/build-daily-report.ts";

const NOW = new Date("2026-09-12T18:00:00.000Z");

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

function post(overrides: Partial<CandidatePost> & { postId: number }): CandidatePost {
  return {
    platform: "tiktok",
    externalId: `ext-${overrides.postId}`,
    canonicalUrl: `https://www.tiktok.com/@creator/video/${overrides.postId}`,
    creatorUsername: `creator${overrides.postId}`,
    caption: "a caption",
    hashtags: ["cosplay"],
    categories: ["cosplay"],
    publishedAt: hoursAgo(2),
    views: 50_000,
    likes: 2000,
    comments: 100,
    shares: 150,
    vph: 10_000,
    vphKind: "OBSERVED",
    velocityConfidence: "HIGH",
    trendScore: 60,
    risingScore: 60,
    trendState: "ACTIVE",
    tier: "VIRAL_QUALIFIED",
    scoreComponents: null,
    availability: "ACTIVE",
    contentType: "video",
    ...overrides,
  };
}

function baseInput(candidatePosts: CandidatePost[], overrides: Partial<BuildDailyReportInput> = {}): BuildDailyReportInput {
  return {
    now: NOW,
    reportDate: "2026-09-12",
    timezone: "UTC",
    market: "global",
    scoringVersion: 1,
    candidatePosts,
    yesterdayPostIds: new Set(),
    yesterday: null,
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
    hashtagSections: { breakout: [], rising: [], topByQualifiedPosts: [] },
    newlyTracked: [],
    demoted: [],
    clusterEdges: [],
    tagTotalPosts: new Map(),
    tagStrength: new Map(),
    ...overrides,
  };
}

describe("buildDailyReport — golden scenario", () => {
  const freshBreakout = post({ postId: 1, platform: "tiktok", creatorUsername: "breakoutcreator", publishedAt: hoursAgo(2), trendScore: 95, risingScore: 95, trendState: "BREAKOUT", tier: "EARLY_BREAKOUT", views: 40_000, vph: 15_000 });
  const freshInstagram = post({ postId: 2, platform: "instagram", creatorUsername: "igcreator", publishedAt: hoursAgo(3), trendScore: 70, risingScore: 65, tier: "VIRAL_QUALIFIED", views: 150_000 });
  const sameCreatorA = post({ postId: 3, platform: "tiktok", creatorUsername: "duplicator", publishedAt: hoursAgo(4), trendScore: 65 });
  const sameCreatorB = post({ postId: 4, platform: "tiktok", creatorUsername: "duplicator", publishedAt: hoursAgo(5), trendScore: 63 });
  const sameCreatorC = post({ postId: 5, platform: "tiktok", creatorUsername: "duplicator", publishedAt: hoursAgo(6), trendScore: 61 }); // must be excluded by cap
  const strong30h = post({ postId: 6, platform: "tiktok", creatorUsername: "stillhotcreator", publishedAt: hoursAgo(30), trendScore: 55, trendState: "ACTIVE" });
  const dead30h = post({ postId: 7, platform: "tiktok", creatorUsername: "deadcreator", publishedAt: hoursAgo(30), trendScore: 20, trendState: "DEAD" });
  const hugeFlatHit = post({ postId: 8, platform: "tiktok", creatorUsername: "hugecreator", publishedAt: hoursAgo(40), views: 5_000_000, vph: 20, trendScore: 30, risingScore: 5, trendState: "STABLE" });

  const allPosts = [freshBreakout, freshInstagram, sameCreatorA, sameCreatorB, sameCreatorC, strong30h, dead30h, hugeFlatHit];
  const report = buildDailyReport(baseInput(allPosts, { yesterdayPostIds: new Set([freshBreakout.postId]) }));

  it("the fresh breakout ranks strongly in Today", () => {
    const ids = report.todayTop.map((i) => i.postId);
    expect(ids).toContain(freshBreakout.postId);
    expect(report.todayTop[0]?.postId).toBe(freshBreakout.postId);
  });

  it("the 30h strong post goes to Still Hot, never Today", () => {
    expect(report.todayTop.map((i) => i.postId)).not.toContain(strong30h.postId);
    expect(report.stillHot.map((i) => i.postId)).toContain(strong30h.postId);
  });

  it("the 30h DEAD post pollutes neither Today nor Still Hot", () => {
    expect(report.todayTop.map((i) => i.postId)).not.toContain(dead30h.postId);
    expect(report.stillHot.map((i) => i.postId)).not.toContain(dead30h.postId);
  });

  it("the huge flat historical hit does not beat current strong trends in Today ranking", () => {
    const breakoutRank = report.todayTop.find((i) => i.postId === freshBreakout.postId)?.rank;
    const hugeRank = report.todayTop.find((i) => i.postId === hugeFlatHit.postId)?.rank;
    expect(breakoutRank).toBeDefined();
    if (hugeRank !== undefined) expect(breakoutRank!).toBeLessThan(hugeRank);
  });

  it("creator cap: only 2 of the 3 same-creator posts appear in Today", () => {
    const creatorPosts = report.todayTop.filter((i) => i.creatorUsername === "duplicator");
    expect(creatorPosts.length).toBeLessThanOrEqual(2);
  });

  it("platform floor: Instagram gets at least one slot despite fewer overall candidates", () => {
    expect(report.todayTop.some((i) => i.platform === "instagram")).toBe(true);
  });

  it("yesterday flag: the breakout post (in yesterday's report) is flagged", () => {
    const item = report.todayTop.find((i) => i.postId === freshBreakout.postId);
    expect(item?.inYesterdayReport).toBe(true);
  });

  it("a post never in yesterday's report is not flagged", () => {
    const item = report.todayTop.find((i) => i.postId === freshInstagram.postId);
    expect(item?.inYesterdayReport).toBe(false);
  });

  it("report status is COMPLETE with no partial reasons supplied", () => {
    expect(report.status).toBe("COMPLETE");
  });
});

describe("buildDailyReport — exact boundary conventions", () => {
  function reportFor(publishedAt: Date) {
    const p = post({ postId: 1, publishedAt, tier: "VIRAL_QUALIFIED", trendState: "ACTIVE" });
    return buildDailyReport(baseInput([p]));
  }

  it("23h59m59s old -> TODAY", () => {
    const r = reportFor(new Date(NOW.getTime() - (24 * 3_600_000 - 1000)));
    expect(r.todayTop).toHaveLength(1);
    expect(r.stillHot).toHaveLength(0);
  });

  it("exactly 24h old -> TODAY (inclusive lower bound)", () => {
    const r = reportFor(new Date(NOW.getTime() - 24 * 3_600_000));
    expect(r.todayTop).toHaveLength(1);
    expect(r.stillHot).toHaveLength(0);
  });

  it("24h + 1ms old -> STILL_HOT, not TODAY", () => {
    const r = reportFor(new Date(NOW.getTime() - 24 * 3_600_000 - 1));
    expect(r.todayTop).toHaveLength(0);
    expect(r.stillHot).toHaveLength(1);
  });

  it("71h59m59s old -> STILL_HOT", () => {
    const r = reportFor(new Date(NOW.getTime() - (72 * 3_600_000 - 1000)));
    expect(r.stillHot).toHaveLength(1);
  });

  it("exactly 72h old -> STILL_HOT (inclusive lower bound)", () => {
    const r = reportFor(new Date(NOW.getTime() - 72 * 3_600_000));
    expect(r.stillHot).toHaveLength(1);
  });

  it("72h + 1ms old -> excluded from both Today and Still Hot", () => {
    const r = reportFor(new Date(NOW.getTime() - 72 * 3_600_000 - 1));
    expect(r.todayTop).toHaveLength(0);
    expect(r.stillHot).toHaveLength(0);
  });

  it("no post ever appears in both Today and Still Hot", () => {
    const posts = Array.from({ length: 10 }, (_, i) => post({ postId: i, publishedAt: new Date(NOW.getTime() - i * 8 * 3_600_000), tier: "VIRAL_QUALIFIED" }));
    const r = buildDailyReport(baseInput(posts));
    const todayIds = new Set(r.todayTop.map((i) => i.postId));
    const stillHotIds = new Set(r.stillHot.map((i) => i.postId));
    for (const id of todayIds) expect(stillHotIds.has(id)).toBe(false);
  });
});

describe("buildDailyReport — PARTIAL propagation", () => {
  it("TikTok fails, Instagram succeeds -> PARTIAL with a clear reason, Instagram data still appears, no fake TikTok padding", () => {
    const igPosts = [post({ postId: 1, platform: "instagram", creatorUsername: "a" }), post({ postId: 2, platform: "instagram", creatorUsername: "b" })];
    const report = buildDailyReport(baseInput(igPosts, { partialReasons: ["tiktok:discovery_failed"] }));

    expect(report.status).toBe("PARTIAL");
    expect(report.partialReasons).toContain("tiktok:discovery_failed");
    expect(report.todayTop.every((i) => i.platform === "instagram")).toBe(true);
    expect(report.todayTop.length).toBe(2);
  });
});

describe("buildDailyReport — idempotency", () => {
  it("same input produces the same logical payload", () => {
    const posts = [post({ postId: 1 }), post({ postId: 2, platform: "instagram" })];
    const first = buildDailyReport(baseInput(posts));
    const second = buildDailyReport(baseInput(posts));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("buildDailyReport — original URL guarantee", () => {
  it("every ranked item's canonicalUrl points at tiktok.com or instagram.com", () => {
    const posts = [post({ postId: 1, platform: "tiktok" }), post({ postId: 2, platform: "instagram", canonicalUrl: "https://www.instagram.com/p/abc/" })];
    const report = buildDailyReport(baseInput(posts));
    for (const item of [...report.todayTop, ...report.stillHot, ...report.risingNow, ...report.exportCandidates]) {
      expect(item.canonicalUrl).toMatch(/^https:\/\/www\.(tiktok|instagram)\.com\//);
    }
  });
});
