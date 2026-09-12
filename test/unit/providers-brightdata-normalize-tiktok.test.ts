import { describe, expect, it } from "vitest";
import { normalizeBrightDataTikTok } from "@/providers/brightdata/normalize-tiktok.ts";
import { loadFixture } from "./helpers/fixtures.ts";

const OBSERVED_AT = new Date("2026-09-12T18:00:00.000Z");
const CONTEXT = { observedAt: OBSERVED_AT, discoveryMethod: "keyword" };

const ALL_FIXTURE_PATHS = [
  "brightdata/tiktok/sample-1b-1.json",
  "brightdata/tiktok/sample-1b-2.json",
  "brightdata/tiktok/sample-1b-3.json",
  "brightdata/tiktok/sample-1b-4.json",
  "brightdata/tiktok/sample-1b-5.json",
];

describe("normalizeBrightDataTikTok — real fixture contract", () => {
  it.each(ALL_FIXTURE_PATHS)("normalizes %s successfully", (path) => {
    const raw = loadFixture(path);
    const result = normalizeBrightDataTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const post = result.post;
    expect(post.platform).toBe("tiktok");
    expect(post.externalId).toMatch(/^\d{5,25}$/);
    expect(post.canonicalUrl).toMatch(/^https:\/\/www\.tiktok\.com\/@[\w.-]+\/video\/\d+$/);
    expect(post.canonicalUrl).toContain(post.externalId);
    expect(post.source.provider).toBe("brightdata");
    if (post.metrics.views === null) {
      expect(post.metrics.viewsMetric).toBeNull();
    } else {
      expect(post.metrics.viewsMetric).toBe("tt_brightdata_play_count");
    }
  });

  it("normalizes a known real post exactly (sample-1b-1.json), and correctly uses the URL handle, not the display nickname", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json");
    const result = normalizeBrightDataTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.post.externalId).toBe("7684005032081067295");
    expect(result.post.canonicalUrl).toBe("https://www.tiktok.com/@irisinribbons/video/7684005032081067295");
    // The real fixture's profile_username is "Iris ♡︎" (a display nickname)
    // — the handle must come from the URL, not that field.
    expect(result.post.creator.username).toBe("irisinribbons");
    expect(result.post.creator.username).not.toBe("Iris ♡︎");
    expect(result.post.creator.followers).toBe(10400);
    expect(result.post.creator.verified).toBe(false);
    expect(result.post.metrics.views).toBe(2895);
    expect(result.post.metrics.likes).toBe(554);
    // share_count is a numeric STRING ("9") in the real fixture
    expect(result.post.metrics.shares).toBe(9);
    expect(result.post.metrics.comments).toBe(27);
    expect(result.post.metrics.saves).toBe(91);
    expect(result.post.hashtags).toEqual(["fyp", "cosplay", "marinkitagawa", "mydressupdarling", "marincosplay"]);
    expect(result.post.publishedAt?.toISOString()).toBe("2026-09-10T20:24:07.000Z");
    expect(result.post.durationSec).toBe(5);
    expect(result.post.music).toEqual({
      id: "7664929259974494993",
      title: "原声",
      author: "狐狸kitsune",
    });
  });

  it("confirms share_count is a numeric string in every real sample (documented systematic behavior)", () => {
    for (const path of ALL_FIXTURE_PATHS) {
      const raw = loadFixture(path) as Record<string, unknown>;
      expect(typeof raw.share_count).toBe("string");
    }
  });

  // --- Mutated fixtures: realistic variants ---

  it("normalizes with missing likes/shares/comments as null, not 0", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.digg_count;
    delete mutated.share_count;
    delete mutated.comment_count;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.metrics.likes).toBeNull();
    expect(result.post.metrics.shares).toBeNull();
    expect(result.post.metrics.comments).toBeNull();
  });

  it("normalizes with missing caption as null", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.description;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.caption).toBeNull();
    // structured hashtags array still yields tags
    expect(result.post.hashtags.length).toBeGreaterThan(0);
  });

  it("normalizes with missing music as null", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.music;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.music).toBeNull();
  });

  it("normalizes with missing follower count as null", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.profile_followers;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.creator.followers).toBeNull();
  });

  it("falls back to profile_url for the handle when url is missing", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.url;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.creator.username).toBe("irisinribbons");
  });

  it("fails with MISSING_ID when post_id is absent", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.post_id;
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("MISSING_ID");
  });

  it("fails with INVALID_URL when neither url nor profile_url is usable", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw, url: "https://cdn.example.com/x.mp4", profile_url: undefined };
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID_URL");
  });

  it("accepts extra unrelated fields (schema is tolerant, not strict)", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const mutated = { ...raw, some_new_field_the_vendor_added: { nested: true } };
    const result = normalizeBrightDataTikTok(mutated, CONTEXT);
    expect(result.ok).toBe(true);
  });

  it("fails with INVALID for a structurally wrong payload", () => {
    const result = normalizeBrightDataTikTok([1, 2, 3], CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID");
  });
});
