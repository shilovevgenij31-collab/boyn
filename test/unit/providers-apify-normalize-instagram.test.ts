import { describe, expect, it } from "vitest";
import { normalizeApifyInstagram } from "@/providers/apify/normalize-instagram.ts";
import { loadFixture } from "./helpers/fixtures.ts";

const OBSERVED_AT = new Date("2026-09-12T18:00:00.000Z");
const CONTEXT = { observedAt: OBSERVED_AT, discoveryMethod: "hashtag" };

const ALL_FIXTURE_PATHS = [
  "apify/instagram/sample-1.json",
  "apify/instagram/sample-2.json",
  "apify/instagram/sample-3.json",
  "apify/instagram/sample-4.json",
  "apify/instagram/sample-5.json",
];

describe("normalizeApifyInstagram — real fixture contract", () => {
  it.each(ALL_FIXTURE_PATHS)("normalizes %s successfully", (path) => {
    const raw = loadFixture(path);
    const result = normalizeApifyInstagram(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const post = result.post;
    expect(post.platform).toBe("instagram");
    expect(post.externalId).toMatch(/^[A-Za-z0-9_-]{5,20}$/);
    expect(post.canonicalUrl).toBe(`https://www.instagram.com/p/${post.externalId}/`);
    expect(post.source.provider).toBe("apify");
    // saves and follower count are never available from this actor
    expect(post.metrics.saves).toBeNull();
    expect(post.creator.followers).toBeNull();
  });

  it("normalizes a known real post exactly (sample-1.json) — including the -1 hidden-likes sentinel", () => {
    const raw = loadFixture("apify/instagram/sample-1.json");
    const result = normalizeApifyInstagram(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.post.externalId).toBe("DdME5ezS62g");
    expect(result.post.canonicalUrl).toBe("https://www.instagram.com/p/DdME5ezS62g/");
    expect(result.post.creator.username).toBe("ameagarie");
    expect(result.post.creator.externalId).toBe("56855706728");
    // real fixture had likesCount: -1
    expect(result.post.metrics.likes).toBeNull();
    expect(result.post.metrics.views).toBe(2520);
    expect(result.post.metrics.viewsMetric).toBe("ig_apify_video_play_count");
    expect(result.post.metrics.comments).toBe(3);
    // reshareCount absent in the real fixture
    expect(result.post.metrics.shares).toBeNull();
    expect(result.post.hashtags).toEqual(["mafuyuasahina", "projectsekai", "cosplay", "踊ってみた", "explore"]);
    expect(result.post.publishedAt?.toISOString()).toBe("2026-09-12T13:20:21.000Z");
    expect(result.post.contentType).toBe("reel");
    expect(result.post.music).toEqual({
      id: "27756469310702416",
      title: "Original audio",
      author: "ameagarie",
    });
  });

  it("confirms videoViewCount is absent in every real sample (documented, not assumed)", () => {
    for (const path of ALL_FIXTURE_PATHS) {
      const raw = loadFixture(path) as Record<string, unknown>;
      expect(raw.videoViewCount).toBeUndefined();
    }
  });

  // --- Mutated fixtures: realistic variants ---

  it("falls back to videoViewCount when videoPlayCount is absent (never observed, but schema-supported)", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.videoPlayCount;
    mutated.videoViewCount = 9999;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.metrics.views).toBe(9999);
    expect(result.post.metrics.viewsMetric).toBe("ig_apify_video_view_count");
  });

  it("views/viewsMetric are both null when no view field is present at all", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.videoPlayCount;
    delete mutated.videoViewCount;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.metrics.views).toBeNull();
    expect(result.post.metrics.viewsMetric).toBeNull();
  });

  it("normalizes with no hashtags array — falls back to caption-only extraction", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.hashtags;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // caption itself contains #mafuyuasahina etc.
    expect(result.post.hashtags.length).toBeGreaterThan(0);
  });

  it("normalizes with missing caption as null", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.caption;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.caption).toBeNull();
  });

  it("derives a canonical URL from a malformed/missing shortCode by falling back to the url field", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.shortCode;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.externalId).toBe("DdME5ezS62g");
  });

  it("fails with MISSING_ID when both shortCode and url are absent", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw };
    delete mutated.shortCode;
    delete mutated.url;
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("MISSING_ID");
  });

  it("fails with INVALID_URL for a malformed shortcode", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw, shortCode: "a", url: undefined };
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID_URL");
  });

  it("maps type: Image to contentType image", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw, type: "Image", productType: undefined };
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.contentType).toBe("image");
  });

  it("maps type: Sidecar to contentType carousel", () => {
    const raw = loadFixture("apify/instagram/sample-1.json") as Record<string, unknown>;
    const mutated = { ...raw, type: "Sidecar", productType: undefined };
    const result = normalizeApifyInstagram(mutated, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.contentType).toBe("carousel");
  });

  it("fails with INVALID for a structurally wrong payload", () => {
    const result = normalizeApifyInstagram(42, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INVALID");
  });
});
