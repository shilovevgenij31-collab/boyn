import { describe, expect, it } from "vitest";
import { normalizeApifyTikTok } from "@/providers/apify/normalize-tiktok.ts";
import { loadFixture } from "./helpers/fixtures.ts";

const OBSERVED_AT = new Date("2026-09-12T18:00:00.000Z");
const CONTEXT = { observedAt: OBSERVED_AT, discoveryMethod: "search" };

// Every real fixture we captured for this (provider, platform): the
// rejected hashtag-mode discovery samples, the production search-mode
// samples, and the one refresh-by-URL sample — all real Apify TikTok
// output, same schema regardless of which discovery mode found them.
const ALL_FIXTURE_PATHS = [
  "apify/tiktok/sample-1.json",
  "apify/tiktok/sample-2.json",
  "apify/tiktok/sample-3.json",
  "apify/tiktok/sample-4.json",
  "apify/tiktok/sample-5.json",
  "apify/tiktok/search-1.json",
  "apify/tiktok/search-2.json",
  "apify/tiktok/search-3.json",
  "apify/tiktok/search-4.json",
  "apify/tiktok/search-5.json",
  "apify/tiktok/refresh-1.json",
];

describe("normalizeApifyTikTok — real fixture contract", () => {
  it.each(ALL_FIXTURE_PATHS)("normalizes %s successfully", (path) => {
    const raw = loadFixture(path);
    const result = normalizeApifyTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const post = result.post;
    expect(post.platform).toBe("tiktok");
    expect(post.externalId).toMatch(/^\d{5,25}$/);
    expect(post.canonicalUrl).toMatch(/^https:\/\/www\.tiktok\.com\/@[\w.-]+\/video\/\d+$/);
    expect(post.canonicalUrl).toContain(post.externalId);
    expect(post.source.provider).toBe("apify");
    expect(post.source.discoveryMethod).toBe("search");
    expect(post.observedAt).toBe(OBSERVED_AT);
    // views/viewsMetric always agree
    if (post.metrics.views === null) {
      expect(post.metrics.viewsMetric).toBeNull();
    } else {
      expect(post.metrics.viewsMetric).toBe("tt_apify_play_count");
    }
  });

  it("normalizes a known real post exactly (search-1.json)", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as { id: string; playCount: number; diggCount: number };
    const result = normalizeApifyTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.post.externalId).toBe("7684691961873272094");
    expect(result.post.canonicalUrl).toBe("https://www.tiktok.com/@celebi.cos/video/7684691961873272094");
    expect(result.post.creator.username).toBe("celebi.cos");
    expect(result.post.creator.followers).toBe(888000);
    expect(result.post.creator.verified).toBe(false);
    expect(result.post.metrics.views).toBe(8831);
    expect(result.post.metrics.viewsMetric).toBe("tt_apify_play_count");
    expect(result.post.metrics.likes).toBe(2898);
    expect(result.post.metrics.shares).toBe(69);
    expect(result.post.metrics.comments).toBe(22);
    expect(result.post.metrics.saves).toBe(451);
    expect(result.post.hashtags).toEqual(["cosplay", "dancetrend", "hatsunemiku"]);
    expect(result.post.publishedAt?.toISOString()).toBe("2026-09-12T16:49:57.000Z");
    expect(result.post.durationSec).toBeCloseTo(17.902);
    expect(result.post.music).toEqual({
      id: "7327114522770393887",
      title: "original sound - ayetaetae_",
      author: "Brooke 👩🏼‍🎤",
    });
    expect(result.post.contentType).toBe("video");
  });

  it("extracts hashtag .name from Apify's array-of-objects shape (not the object itself)", () => {
    const raw = loadFixture("apify/tiktok/search-2.json");
    const result = normalizeApifyTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.hashtags).toContain("saber");
    expect(result.post.hashtags).toContain("sabercosplay");
    expect(result.post.hashtags.every((h) => typeof h === "string")).toBe(true);
  });

  // --- Mutated fixtures: realistic missing-field variants ---

  it("normalizes with missing shares/likes/comments as null, not 0", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.shareCount;
    delete mutated.diggCount;
    delete mutated.commentCount;
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.metrics.shares).toBeNull();
    expect(result.post.metrics.likes).toBeNull();
    expect(result.post.metrics.comments).toBeNull();
    // views is independent and still present
    expect(result.post.metrics.views).not.toBeNull();
  });

  it("normalizes with missing caption as null (not empty string)", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.text;
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.caption).toBeNull();
    // hashtags should still come from the structured hashtags array
    expect(result.post.hashtags.length).toBeGreaterThan(0);
  });

  it("normalizes with missing music as null", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.musicMeta;
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.music).toBeNull();
  });

  it("normalizes with missing creator follower count as null", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const authorMeta = { ...(raw.authorMeta as Record<string, unknown>) };
    delete authorMeta.fans;
    const mutated = { ...raw, authorMeta };
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.creator.followers).toBeNull();
    // username should still resolve — it comes from the URL, not authorMeta.fans
    expect(result.post.creator.username).not.toBeNull();
  });

  it("accepts a numeric string for a count field (defensive, mirrors real Bright Data behavior)", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw, playCount: "8831" };
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.metrics.views).toBe(8831);
  });

  it("fails with MISSING_ID when id is absent", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.id;
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("MISSING_ID");
  });

  it("fails with INVALID_URL when webVideoUrl is malformed and no handle fallback exists", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const authorMeta = { ...(raw.authorMeta as Record<string, unknown>) };
    delete authorMeta.name;
    delete authorMeta.uniqueId;
    const mutated = { ...raw, webVideoUrl: "https://cdn.example.com/video.mp4", authorMeta };
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID_URL");
  });

  it("falls back to authorMeta.name for canonical URL when webVideoUrl is missing", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.webVideoUrl;
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.canonicalUrl).toContain("@celebi.cos");
  });

  it("fails with INVALID for a structurally wrong payload (not an object)", () => {
    const result = normalizeApifyTikTok("this is not a post", CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID");
    expect(result.issues).toBeDefined();
  });

  it("maps isSlideshow: true to contentType carousel", () => {
    const raw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const mutated = { ...raw, isSlideshow: true };
    const result = normalizeApifyTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.contentType).toBe("carousel");
  });
});
