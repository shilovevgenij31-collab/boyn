import { z } from "zod";

/**
 * Raw shape of an `apify/instagram-hashtag-scraper` result item, built
 * from real sanitized fixtures (test/fixtures/apify/instagram/*.json).
 *
 * Real, verified in every Phase 1 sample:
 *   - `hashtags` is a plain string array (unlike TikTok's array-of-objects).
 *   - `likesCount` can be `-1` (creator hid the count).
 *   - `videoPlayCount` was present and numeric on all 5 samples;
 *     `videoViewCount` and `reshareCount` were absent on all 5 — both stay
 *     optional/schema-supported but must never be assumed present.
 *   - No follower-count field exists anywhere on the post object.
 */
const ApifyInstagramMusicInfoSchema = z
  .object({
    audio_id: z.string().optional(),
    song_name: z.string().optional(),
    artist_name: z.string().optional(),
  })
  .passthrough();

export const ApifyInstagramPostSchema = z
  .object({
    id: z.string().optional(),
    shortCode: z.string().optional(),
    type: z.string().optional(),
    productType: z.string().optional(),
    url: z.string().optional(),
    caption: z.string().nullable().optional(),
    hashtags: z.array(z.string()).optional(),
    likesCount: z.number().optional(),
    videoPlayCount: z.number().optional(),
    videoViewCount: z.number().optional(),
    commentsCount: z.number().optional(),
    reshareCount: z.number().optional(),
    timestamp: z.string().optional(),
    ownerUsername: z.string().optional(),
    ownerId: z.string().optional(),
    videoDuration: z.number().optional(),
    musicInfo: ApifyInstagramMusicInfoSchema.optional(),
  })
  .passthrough();

export type ApifyInstagramPost = z.infer<typeof ApifyInstagramPostSchema>;
