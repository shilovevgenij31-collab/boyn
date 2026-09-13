import { describe, expect, it } from "vitest";
import {
  classifyHashtagByKeyword,
  classifyHashtagBySeed,
  classifyHashtagFromCooccurrence,
  mergeHashtagCategoryEvidence,
} from "@/core/categories/classify-hashtag.ts";
import { classifyPost } from "@/core/categories/classify-post.ts";

describe("classifyHashtagBySeed", () => {
  it("returns the configured seed categories at confidence 1.0", () => {
    const result = classifyHashtagBySeed("cosplay");
    expect(result).toEqual([{ category: "cosplay", confidence: 1.0, source: "SEED" }]);
  });

  it("returns [] for a tag not in the committed seed list", () => {
    expect(classifyHashtagBySeed("someRandomDiscoveredTag")).toEqual([]);
  });
});

describe("classifyHashtagByKeyword", () => {
  it("matches multi-label overlap: pcgaming -> pc AND gaming", () => {
    const result = classifyHashtagByKeyword("pcgaming");
    const categories = result.map((r) => r.category).sort();
    expect(categories).toEqual(["gaming", "pc"]);
  });

  it("ps5game -> gaming AND playstation", () => {
    const categories = classifyHashtagByKeyword("ps5game").map((r) => r.category).sort();
    expect(categories).toEqual(["gaming", "playstation"]);
  });

  it("streaming keyword match", () => {
    expect(classifyHashtagByKeyword("twitchstreamer").map((r) => r.category)).toContain("streaming");
  });

  it("no match -> []", () => {
    expect(classifyHashtagByKeyword("unrelatedword")).toEqual([]);
  });

  it("keyword confidence is 0.9", () => {
    const result = classifyHashtagByKeyword("cosplay");
    expect(result[0]?.confidence).toBe(0.9);
    expect(result[0]?.source).toBe("KEYWORD");
  });
});

describe("classifyHashtagFromCooccurrence", () => {
  it("requires at least 5 total posts", () => {
    expect(classifyHashtagFromCooccurrence(4, { gaming: 1 })).toEqual([]);
  });

  it("assigns a category when its share clears the 0.4 threshold", () => {
    const result = classifyHashtagFromCooccurrence(10, { gaming: 0.5, cosplay: 0.2 });
    expect(result).toEqual([{ category: "gaming", confidence: 0.5, source: "COOCCURRENCE" }]);
  });

  it("does not infer a category from one weak accidental co-occurrence", () => {
    expect(classifyHashtagFromCooccurrence(10, { gaming: 0.1 })).toEqual([]);
  });
});

describe("mergeHashtagCategoryEvidence", () => {
  it("keeps the highest-confidence evidence per category across sources", () => {
    const seed = [{ category: "gaming" as const, confidence: 1.0, source: "SEED" as const }];
    const keyword = [{ category: "gaming" as const, confidence: 0.9, source: "KEYWORD" as const }, { category: "pc" as const, confidence: 0.9, source: "KEYWORD" as const }];
    const merged = mergeHashtagCategoryEvidence(seed, keyword);
    const gaming = merged.find((m) => m.category === "gaming");
    expect(gaming?.confidence).toBe(1.0);
    expect(gaming?.source).toBe("SEED");
    expect(merged.find((m) => m.category === "pc")?.source).toBe("KEYWORD");
  });
});

describe("classifyPost", () => {
  it("takes the union of tag categories (confidence >= 0.5), query category, and caption keywords", () => {
    const result = classifyPost({
      hashtagCategories: [
        { category: "cosplay", confidence: 1.0 },
        { category: "gaming", confidence: 0.3 }, // below threshold, excluded
      ],
      queryCategory: "streaming",
      caption: "playing on my ps5 today",
    });
    const categories = result.map((r) => r.category).sort();
    expect(categories).toEqual(["cosplay", "playstation", "streaming"]);
  });

  it("supports multi-label output — a post is never forced into exactly one category", () => {
    const result = classifyPost({ hashtagCategories: [{ category: "cosplay", confidence: 1 }, { category: "gaming", confidence: 1 }] });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("no evidence at all -> []", () => {
    expect(classifyPost({ hashtagCategories: [] })).toEqual([]);
  });
});
