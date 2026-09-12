import { z } from "zod";

/**
 * Raw shape of a Bright Data TikTok Posts dataset item
 * (gd_lu702nij2f790tmv9h), built from real sanitized fixtures
 * (test/fixtures/brightdata/tiktok/*.json — both the "Discover by
 * keyword" and "Collect by URL" modes return this same shape).
 *
 * Real, verified across all 6 samples (5 discovery + 1 refresh):
 *   - `share_count` is consistently a numeric STRING ("9", "179", ...)
 *     while every sibling count field (`digg_count`, `comment_count`,
 *     `play_count`) is a plain number — an actual, systematic provider
 *     inconsistency, not a one-off.
 *   - `shortcode` duplicates `post_id` (TikTok has no Instagram-style
 *     shortcode) — not used; `post_id` is the id we normalize on.
 *   - `profile_username` is a DISPLAY NICKNAME ("Iris ♡︎"), not the real
 *     @handle — see core/normalize/canonical-url.ts module comment.
 *   - `account_id` / `tt_chain_token` appear as "[REDACTED]" in our
 *     fixtures (our own sanitizer strips them pre-commit as sensitive-
 *     looking keys) — neither is needed for normalization.
 */
const BrightDataTikTokMusicSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    authorname: z.string().optional(),
  })
  .passthrough();

const BrightDataDiscoveryInputSchema = z
  .object({
    search_keyword: z.string().optional(),
  })
  .passthrough();

export const BrightDataTikTokPostSchema = z
  .object({
    post_id: z.union([z.string(), z.number()]).optional(),
    url: z.string().optional(),
    description: z.string().nullable().optional(),
    create_time: z.union([z.string(), z.number()]).optional(),
    digg_count: z.union([z.number(), z.string()]).optional(),
    share_count: z.union([z.number(), z.string()]).optional(),
    comment_count: z.union([z.number(), z.string()]).optional(),
    play_count: z.union([z.number(), z.string()]).optional(),
    collect_count: z.union([z.number(), z.string()]).optional(),
    video_duration: z.union([z.number(), z.string()]).optional(),
    hashtags: z.array(z.string()).optional(),
    profile_id: z.string().optional(),
    profile_username: z.string().optional(),
    profile_url: z.string().optional(),
    profile_followers: z.union([z.number(), z.string()]).optional(),
    is_verified: z.boolean().optional(),
    post_type: z.string().optional(),
    music: BrightDataTikTokMusicSchema.optional(),
    discovery_input: BrightDataDiscoveryInputSchema.optional(),
    input: z
      .object({
        discovery_input: BrightDataDiscoveryInputSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type BrightDataTikTokPost = z.infer<typeof BrightDataTikTokPostSchema>;
