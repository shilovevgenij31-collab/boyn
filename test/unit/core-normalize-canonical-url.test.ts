import { describe, expect, it } from "vitest";
import {
  buildInstagramCanonicalUrl,
  buildTikTokCanonicalUrl,
  parseInstagramPostUrl,
  parseTikTokProfileUrl,
  parseTikTokVideoUrl,
} from "@/core/normalize/canonical-url.ts";

describe("parseTikTokVideoUrl", () => {
  it("parses a real TikTok video URL", () => {
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@celebi.cos/video/7684691961873272094")).toEqual({
      handle: "celebi.cos",
      id: "7684691961873272094",
    });
  });

  it("works without the www subdomain", () => {
    expect(parseTikTokVideoUrl("https://tiktok.com/@user/video/12345")).toEqual({ handle: "user", id: "12345" });
  });

  it("ignores tracking query strings and fragments", () => {
    expect(
      parseTikTokVideoUrl("https://www.tiktok.com/@user/video/12345?is_from_webapp=1&sender_device=pc#comment-1"),
    ).toEqual({ handle: "user", id: "12345" });
  });

  it("rejects a non-TikTok host", () => {
    expect(parseTikTokVideoUrl("https://example.com/@user/video/12345")).toBeNull();
  });

  it("rejects a CDN media URL", () => {
    expect(
      parseTikTokVideoUrl("https://v16-webapp-prime.us.tiktok.com/video/tos/useast8/tos-useast8-ve-0068c001-tx2/abc/"),
    ).toBeNull();
  });

  it("rejects a profile-only URL (no /video/id)", () => {
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@user")).toBeNull();
  });

  it("rejects malformed strings without throwing", () => {
    expect(parseTikTokVideoUrl("javascript:alert(1)")).toBeNull();
    expect(parseTikTokVideoUrl("not a url")).toBeNull();
    expect(parseTikTokVideoUrl("")).toBeNull();
    expect(parseTikTokVideoUrl(null)).toBeNull();
    expect(parseTikTokVideoUrl(undefined)).toBeNull();
  });

  it("rejects a non-numeric video id", () => {
    expect(parseTikTokVideoUrl("https://www.tiktok.com/@user/video/abc123")).toBeNull();
  });
});

describe("parseTikTokProfileUrl", () => {
  it("parses a profile URL", () => {
    expect(parseTikTokProfileUrl("https://www.tiktok.com/@irisinribbons")).toBe("irisinribbons");
  });

  it("rejects a non-TikTok host", () => {
    expect(parseTikTokProfileUrl("https://example.com/@irisinribbons")).toBeNull();
  });
});

describe("buildTikTokCanonicalUrl", () => {
  it("builds a clean canonical URL from valid parts", () => {
    expect(buildTikTokCanonicalUrl("celebi.cos", "7684691961873272094")).toBe(
      "https://www.tiktok.com/@celebi.cos/video/7684691961873272094",
    );
  });

  it("rejects an invalid handle", () => {
    expect(buildTikTokCanonicalUrl("has spaces", "12345")).toBeNull();
    expect(buildTikTokCanonicalUrl("", "12345")).toBeNull();
  });

  it("rejects a non-numeric id", () => {
    expect(buildTikTokCanonicalUrl("user", "not-a-number")).toBeNull();
    expect(buildTikTokCanonicalUrl("user", "")).toBeNull();
  });
});

describe("parseInstagramPostUrl", () => {
  it("parses a /p/ permalink (the real observed form, even for reels)", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/p/DdME5ezS62g/")).toBe("DdME5ezS62g");
  });

  it("also accepts /reel/, /reels/, /tv/ forms", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/reel/DdME5ezS62g/")).toBe("DdME5ezS62g");
    expect(parseInstagramPostUrl("https://www.instagram.com/reels/DdME5ezS62g/")).toBe("DdME5ezS62g");
    expect(parseInstagramPostUrl("https://www.instagram.com/tv/DdME5ezS62g/")).toBe("DdME5ezS62g");
  });

  it("ignores query strings", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/p/DdME5ezS62g/?igsh=abc123")).toBe("DdME5ezS62g");
  });

  it("rejects a non-Instagram host", () => {
    expect(parseInstagramPostUrl("https://example.com/p/DdME5ezS62g/")).toBeNull();
  });

  it("rejects a CDN media URL", () => {
    expect(parseInstagramPostUrl("https://scontent-arn2-1.cdninstagram.com/v/t51.82787-15/abc.jpg")).toBeNull();
  });

  it("rejects malformed strings without throwing", () => {
    expect(parseInstagramPostUrl("javascript:alert(1)")).toBeNull();
    expect(parseInstagramPostUrl("not a url")).toBeNull();
    expect(parseInstagramPostUrl(null)).toBeNull();
  });

  it("rejects the hashtag explore page (not a post permalink)", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/explore/tags/cosplay")).toBeNull();
  });
});

describe("buildInstagramCanonicalUrl", () => {
  it("builds a clean /p/ canonical URL", () => {
    expect(buildInstagramCanonicalUrl("DdME5ezS62g")).toBe("https://www.instagram.com/p/DdME5ezS62g/");
  });

  it("rejects an invalid shortcode", () => {
    expect(buildInstagramCanonicalUrl("has spaces")).toBeNull();
    expect(buildInstagramCanonicalUrl("")).toBeNull();
    expect(buildInstagramCanonicalUrl("a")).toBeNull(); // too short
  });
});
