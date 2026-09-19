/**
 * Pagination page rendering (Phase 8 brief §22, §73-75): message size,
 * URL button correctness, callback_data size.
 */
import { describe, expect, it } from "vitest";
import { renderPage, totalPagesFor, PAGE_SIZE } from "@/telegram/render/page.ts";
import type { ReportItem } from "@/core/report/types.ts";

function makeItem(overrides: Partial<ReportItem> & { rank: number; postId: number }): ReportItem {
  return {
    platform: "tiktok",
    canonicalUrl: `https://www.tiktok.com/@creator/video/${overrides.postId}`,
    externalId: `ext-${overrides.postId}`,
    creatorUsername: "creator",
    captionPreview: "a caption",
    hashtags: ["cosplay"],
    categories: ["cosplay"],
    publishedAt: new Date().toISOString(),
    ageHours: 3,
    views: 50_000,
    likes: 2_000,
    comments: 100,
    shares: 50,
    vph: 10_000,
    vphKind: "OBSERVED",
    velocityConfidence: "HIGH",
    trendScore: 80,
    risingScore: 70,
    trendState: "ACTIVE",
    tier: "VIRAL_QUALIFIED",
    scoreComponents: null,
    window: "LIVE",
    inYesterdayReport: false,
    ...overrides,
  };
}

describe("renderPage — one card", () => {
  it("stays well under the 4096-char hard limit", () => {
    const items = [makeItem({ rank: 1, postId: 1 })];
    const page = renderPage(items, 1, "view123456ab", "<b>Header</b>");
    expect(page.text.length).toBeLessThanOrEqual(4096);
  });
});

describe("renderPage — five-card page", () => {
  it("stays well under the 4096-char hard limit with long captions/Unicode/emoji", () => {
    const longCaption = "🎉".repeat(100) + " Кириллица 日本語 " + "a".repeat(200);
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => makeItem({ rank: i + 1, postId: i + 1, captionPreview: longCaption, hashtags: ["cosplay", "arcane", "jinxcosplay", "gaming"] }));
    const page = renderPage(items, 1, "view123456ab", "<b>Header</b>");
    expect(page.text.length).toBeLessThanOrEqual(4096);
  });

  it("shows exactly 5 URL buttons for a full page", () => {
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => makeItem({ rank: i + 1, postId: i + 1 }));
    const page = renderPage(items, 1, "view123456ab", "Header");
    expect(page.replyMarkup.inline_keyboard[0]).toHaveLength(PAGE_SIZE);
  });
});

describe("renderPage — missing metrics / huge metrics", () => {
  it("never crashes and stays under the limit with all-null metrics", () => {
    const items = [makeItem({ rank: 1, postId: 1, views: null, likes: null, comments: null, shares: null, vph: null, vphKind: "NONE", velocityConfidence: null, trendScore: null, risingScore: null, ageHours: null, creatorUsername: null, captionPreview: null })];
    const page = renderPage(items, 1, "view123456ab", "Header");
    expect(page.text.length).toBeLessThanOrEqual(4096);
    expect(page.text).not.toContain("0 просмотров"); // null must never render as 0
  });

  it("never crashes with huge metrics", () => {
    const items = [makeItem({ rank: 1, postId: 1, views: 999_999_999, vph: 50_000_000, likes: 100_000_000, comments: 5_000_000, shares: 2_000_000 })];
    const page = renderPage(items, 1, "view123456ab", "Header");
    expect(page.text.length).toBeLessThanOrEqual(4096);
  });
});

describe("renderPage — URL buttons", () => {
  it("every URL button is https and points at the original tiktok.com/instagram.com post", () => {
    const items = [
      makeItem({ rank: 1, postId: 1, platform: "tiktok", canonicalUrl: "https://www.tiktok.com/@x/video/1" }),
      makeItem({ rank: 2, postId: 2, platform: "instagram", canonicalUrl: "https://www.instagram.com/p/abc/" }),
    ];
    const page = renderPage(items, 1, "view123456ab", "Header");
    for (const btn of page.replyMarkup.inline_keyboard[0]!) {
      expect(btn.url).toBeDefined();
      const url = new URL(btn.url!);
      expect(url.protocol).toBe("https:");
      expect(["www.tiktok.com", "www.instagram.com"]).toContain(url.host);
    }
  });

  it("never produces a provider/CDN/internal URL button", () => {
    const items = [makeItem({ rank: 1, postId: 1, canonicalUrl: "https://www.tiktok.com/@x/video/1" })];
    const page = renderPage(items, 1, "view123456ab", "Header");
    const urls = page.replyMarkup.inline_keyboard[0]!.map((b) => b.url);
    for (const url of urls) {
      expect(url).not.toMatch(/apify\.com|brightdata\.com|tiktokcdn|cdninstagram|localhost/);
    }
  });
});

describe("renderPage — callback_data size", () => {
  it("every callback_data in the nav row is <= 64 bytes", () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ rank: i + 1, postId: i + 1 }));
    const page = renderPage(items, 3, "view123456ab", "Header");
    const navRow = page.replyMarkup.inline_keyboard[page.replyMarkup.inline_keyboard.length - 1]!;
    for (const btn of navRow) {
      if (btn.callback_data) expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("renderPage — pagination bounds", () => {
  it("clamps a requested page above the total to the last page", () => {
    const items = Array.from({ length: 7 }, (_, i) => makeItem({ rank: i + 1, postId: i + 1 }));
    const page = renderPage(items, 99, "view123456ab", "Header");
    expect(page.page).toBe(totalPagesFor(7));
  });

  it("clamps a requested page below 1 to page 1", () => {
    const items = Array.from({ length: 7 }, (_, i) => makeItem({ rank: i + 1, postId: i + 1 }));
    const page = renderPage(items, -5, "view123456ab", "Header");
    expect(page.page).toBe(1);
  });

  it("omits the Prev button on page 1 and the Next button on the last page", () => {
    const items = Array.from({ length: 7 }, (_, i) => makeItem({ rank: i + 1, postId: i + 1 }));
    const first = renderPage(items, 1, "view123456ab", "Header");
    const navFirst = first.replyMarkup.inline_keyboard[1]!;
    expect(navFirst.some((b) => b.text.includes("Назад"))).toBe(false);

    const last = renderPage(items, totalPagesFor(7), "view123456ab", "Header");
    const navLast = last.replyMarkup.inline_keyboard[1]!;
    expect(navLast.some((b) => b.text.includes("Далее"))).toBe(false);
  });
});
