import { describe, expect, it } from "vitest";
import {
  extractHashtagsFromCaption,
  extractRawHashtagNames,
  mergeHashtags,
  normalizeHashtagToken,
} from "@/core/normalize/hashtags.ts";

describe("extractRawHashtagNames", () => {
  it("extracts from an array of plain strings (Bright Data TikTok / Apify Instagram shape)", () => {
    expect(extractRawHashtagNames(["cosplay", "gaming"])).toEqual(["cosplay", "gaming"]);
  });

  it("extracts .name from an array of objects (Apify TikTok shape)", () => {
    expect(extractRawHashtagNames([{ id: "1", name: "cosplay" }, { name: "ps5" }])).toEqual(["cosplay", "ps5"]);
  });

  it("skips malformed entries instead of throwing", () => {
    expect(extractRawHashtagNames([null, 42, {}, { name: "ok" }, "also-ok"])).toEqual(["ok", "also-ok"]);
  });

  it("returns [] for non-array input", () => {
    expect(extractRawHashtagNames(undefined)).toEqual([]);
    expect(extractRawHashtagNames(null)).toEqual([]);
    expect(extractRawHashtagNames("not an array")).toEqual([]);
  });
});

describe("normalizeHashtagToken", () => {
  it("strips a leading #, lowercases, trims", () => {
    expect(normalizeHashtagToken("#Cosplay")).toBe("cosplay");
    expect(normalizeHashtagToken("  gaming  ")).toBe("gaming");
  });

  it("preserves Cyrillic and CJK characters (never reduces to ASCII)", () => {
    expect(normalizeHashtagToken("#радуга")).toBe("радуга");
    expect(normalizeHashtagToken("#踊ってみた")).toBe("踊ってみた");
  });

  it("keeps digits and underscore", () => {
    expect(normalizeHashtagToken("#ps5")).toBe("ps5");
    expect(normalizeHashtagToken("#some_tag_2026")).toBe("some_tag_2026");
  });

  it("does NOT filter generic tags — that's an analytics concern, not normalization", () => {
    expect(normalizeHashtagToken("#fyp")).toBe("fyp");
    expect(normalizeHashtagToken("#viral")).toBe("viral");
  });

  it("rejects empty tokens", () => {
    expect(normalizeHashtagToken("#")).toBeNull();
    expect(normalizeHashtagToken("")).toBeNull();
    expect(normalizeHashtagToken("   ")).toBeNull();
  });

  it("rejects tokens containing invalid characters (spaces, punctuation)", () => {
    expect(normalizeHashtagToken("two words")).toBeNull();
    expect(normalizeHashtagToken("has-dash")).toBeNull();
    expect(normalizeHashtagToken("has.dot")).toBeNull();
  });

  it("rejects pathologically long tokens", () => {
    expect(normalizeHashtagToken("a".repeat(101))).toBeNull();
    expect(normalizeHashtagToken("a".repeat(100))).toBe("a".repeat(100));
  });
});

describe("extractHashtagsFromCaption", () => {
  it("extracts multiple hashtags from caption text", () => {
    expect(extractHashtagsFromCaption("check this out #cosplay #ps5 amazing")).toEqual(["cosplay", "ps5"]);
  });

  it("returns [] for null or hashtag-free captions", () => {
    expect(extractHashtagsFromCaption(null)).toEqual([]);
    expect(extractHashtagsFromCaption("no tags here")).toEqual([]);
  });

  it("extracts Unicode hashtags from caption", () => {
    expect(extractHashtagsFromCaption("🧬🧬 #mafuyuasahina #踊ってみた")).toEqual(["mafuyuasahina", "踊ってみた"]);
  });
});

describe("mergeHashtags", () => {
  it("normalizes, merges, and deduplicates across multiple sources, preserving first-seen order", () => {
    const result = mergeHashtags(["Cosplay", "PS5"], ["ps5", "gaming"]);
    expect(result).toEqual(["cosplay", "ps5", "gaming"]);
  });

  it("drops invalid tokens from any source without failing the whole merge", () => {
    const result = mergeHashtags(["cosplay", ""], ["", "gaming"]);
    expect(result).toEqual(["cosplay", "gaming"]);
  });

  it("returns [] when every source is empty", () => {
    expect(mergeHashtags([], [])).toEqual([]);
  });
});
