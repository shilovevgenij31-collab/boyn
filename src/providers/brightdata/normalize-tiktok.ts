import type { NormalizeContext, NormalizeResult } from "@/core/domain/social-post.ts";
import { buildTikTokCanonicalUrl, parseTikTokProfileUrl, parseTikTokVideoUrl } from "@/core/normalize/canonical-url.ts";
import { extractHashtagsFromCaption, mergeHashtags } from "@/core/normalize/hashtags.ts";
import { parseCount, parseDuration } from "@/core/normalize/numbers.ts";
import { parseProviderDate } from "@/core/normalize/dates.ts";
import { BrightDataTikTokPostSchema } from "./schema-tiktok.ts";

/** The handle is taken from a URL, never from `profile_username` (which is
 * a display nickname, not the @handle — see schema-tiktok.ts). `url` is
 * tried first (it's the video permalink itself); `profile_url` is the
 * fallback when `url` is missing/malformed. */
function resolveHandle(raw: { url?: string; profile_url?: string }): string | null {
  const fromVideoUrl = parseTikTokVideoUrl(raw.url)?.handle;
  if (fromVideoUrl) return fromVideoUrl;
  return parseTikTokProfileUrl(raw.profile_url);
}

/** No content-type signal (e.g. a slideshow flag) is exposed by this
 * dataset in any observed fixture — only `post_type: "video"`. Mapped
 * conservatively: anything else is "unknown" rather than guessed. */
function resolveContentType(postType: string | undefined): "video" | "unknown" {
  return postType === "video" ? "video" : "unknown";
}

export function normalizeBrightDataTikTok(raw: unknown, context: NormalizeContext): NormalizeResult {
  const parsed = BrightDataTikTokPostSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, kind: "INVALID", reason: "raw payload failed Bright Data TikTok schema validation", issues: parsed.error.issues };
  }
  const post = parsed.data;

  const externalId = post.post_id !== undefined ? String(post.post_id) : null;
  if (!externalId || !/^\d{5,25}$/.test(externalId)) {
    return { ok: false, kind: "MISSING_ID", reason: "no valid numeric TikTok video id (`post_id`) present" };
  }

  const handle = resolveHandle(post);
  const canonicalUrl = handle ? buildTikTokCanonicalUrl(handle, externalId) : null;
  if (!canonicalUrl) {
    return { ok: false, kind: "INVALID_URL", reason: "could not construct a canonical tiktok.com URL (no usable handle/url)" };
  }

  const caption = post.description ?? null;
  const hashtags = mergeHashtags(post.hashtags ?? [], extractHashtagsFromCaption(caption));
  const views = parseCount(post.play_count);

  const music =
    post.music && (post.music.id || post.music.title || post.music.authorname)
      ? { id: post.music.id ?? null, title: post.music.title ?? null, author: post.music.authorname ?? null }
      : null;

  // Attribution field (used by the spike, not needed for normalization
  // itself, but documented here for anyone wiring up discoveryMethod
  // detection later): post.discovery_input?.search_keyword ??
  // post.input?.discovery_input?.search_keyword.

  return {
    ok: true,
    post: {
      platform: "tiktok",
      externalId,
      canonicalUrl,
      contentType: resolveContentType(post.post_type),
      creator: {
        username: handle,
        externalId: post.profile_id ?? null,
        followers: parseCount(post.profile_followers),
        verified: post.is_verified ?? null,
      },
      caption,
      hashtags,
      music,
      publishedAt: parseProviderDate(post.create_time),
      durationSec: parseDuration(post.video_duration),
      metrics: {
        views,
        viewsMetric: views !== null ? "tt_brightdata_play_count" : null,
        likes: parseCount(post.digg_count),
        comments: parseCount(post.comment_count),
        shares: parseCount(post.share_count),
        saves: parseCount(post.collect_count),
      },
      observedAt: context.observedAt,
      source: { provider: "brightdata", discoveryMethod: context.discoveryMethod ?? null },
    },
  };
}
