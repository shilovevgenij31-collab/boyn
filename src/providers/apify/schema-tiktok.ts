import { z } from "zod";

/**
 * Raw shape of a `clockworks/tiktok-scraper` (Apify) result item, built
 * directly from real sanitized fixtures (test/fixtures/apify/tiktok/*.json
 * — both the rejected hashtag-mode samples and the production search-mode
 * samples share this schema; only the discovery input differs).
 *
 * `.passthrough()` throughout: the actor returns many fields we don't use
 * (locationCreated, effectStickers, mediaUrls, ...) and adding one more
 * should never break validation. Fields we DO consume are still typed —
 * this isn't `z.any()`, it tolerates *extra* fields, not wrong ones.
 *
 * `id` is a real string in every observed fixture (19-digit TikTok video
 * ids); `z.union([z.string(), z.number()])` is a defensive fallback only
 * — if a provider ever sent it as a raw JSON number, precision would
 * already be lost by JSON.parse before our code runs, which Phase 2 can't
 * fix retroactively.
 */

const ApifyTikTokAuthorMetaSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    uniqueId: z.string().optional(),
    verified: z.boolean().optional(),
    fans: z.number().optional(),
  })
  .passthrough();

const ApifyTikTokHashtagEntrySchema = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);

const ApifyTikTokMusicMetaSchema = z
  .object({
    musicId: z.string().optional(),
    musicName: z.string().optional(),
    musicAuthor: z.string().optional(),
  })
  .passthrough();

const ApifyTikTokVideoMetaSchema = z
  .object({
    duration: z.number().optional(),
  })
  .passthrough();

export const ApifyTikTokPostSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    text: z.string().nullable().optional(),
    createTime: z.union([z.number(), z.string()]).optional(),
    createTimeISO: z.string().optional(),
    webVideoUrl: z.string().optional(),
    authorMeta: ApifyTikTokAuthorMetaSchema.optional(),
    musicMeta: ApifyTikTokMusicMetaSchema.optional(),
    videoMeta: ApifyTikTokVideoMetaSchema.optional(),
    diggCount: z.union([z.number(), z.string()]).optional(),
    shareCount: z.union([z.number(), z.string()]).optional(),
    playCount: z.union([z.number(), z.string()]).optional(),
    commentCount: z.union([z.number(), z.string()]).optional(),
    collectCount: z.union([z.number(), z.string()]).optional(),
    hashtags: z.array(ApifyTikTokHashtagEntrySchema).optional(),
    isSlideshow: z.boolean().optional(),
    // Attribution: present only for search-mode discovery (our production
    // path); hashtag-mode results carry `searchHashtag`/`input` instead
    // (see Phase 1 findings) — neither is required for normalization.
    searchQuery: z.string().optional(),
  })
  .passthrough();

export type ApifyTikTokPost = z.infer<typeof ApifyTikTokPostSchema>;
