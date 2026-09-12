import type { NormalizedPost } from "@/core/domain/social-post.ts";

/** A minimal, fully-valid NormalizedPost for repository tests — override
 * only the fields a given test cares about. */
export function fakeNormalizedPost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  return {
    platform: "tiktok",
    externalId: "1000000000000000001",
    canonicalUrl: "https://www.tiktok.com/@tester/video/1000000000000000001",
    contentType: "video",
    creator: { username: "tester", externalId: "creator-1", followers: 1000, verified: false },
    caption: "a test caption #test",
    hashtags: ["test"],
    music: { id: "music-1", title: "Test Song", author: "Test Artist" },
    publishedAt: new Date("2026-09-12T10:00:00.000Z"),
    durationSec: 15,
    metrics: { views: 1000, viewsMetric: "tt_apify_play_count", likes: 100, comments: 10, shares: 5, saves: 2 },
    observedAt: new Date("2026-09-12T12:00:00.000Z"),
    source: { provider: "apify", discoveryMethod: "search" },
    ...overrides,
  };
}
