import type { NormalizeContext, NormalizeResult } from "@/core/domain/social-post.ts";
import type { ContentType } from "@/core/domain/content-type.ts";
import type { ViewsMetric } from "@/core/domain/views-metric.ts";
import { buildInstagramCanonicalUrl, parseInstagramPostUrl } from "@/core/normalize/canonical-url.ts";
import { extractHashtagsFromCaption, mergeHashtags } from "@/core/normalize/hashtags.ts";
import { parseCount, parseDuration } from "@/core/normalize/numbers.ts";
import { parseProviderDate } from "@/core/normalize/dates.ts";
import { ApifyInstagramPostSchema } from "./schema-instagram.ts";

/**
 * All 5 Phase 1 samples were `type: "Video"` + `productType: "clips"`
 * (a Reel). Other Instagram content types (Image, Sidecar/carousel) are
 * documented Apify/Instagram values but were never observed here — mapped
 * defensively, not fabricated: if a future post has them, this maps
 * sensibly instead of falling through to "unknown".
 */
function resolveContentType(raw: { type?: string; productType?: string }): ContentType {
  if (raw.productType === "clips") return "reel";
  if (raw.type === "Image") return "image";
  if (raw.type === "Sidecar") return "carousel";
  if (raw.type === "Video") return "video";
  return "unknown";
}

/** videoPlayCount was present on 100% of real samples; videoViewCount was
 * present on 0%. Both are tried, in that order, and viewsMetric always
 * records exactly which one actually supplied the value — never assumed. */
function resolveViews(raw: { videoPlayCount?: number; videoViewCount?: number }): {
  views: number | null;
  viewsMetric: ViewsMetric | null;
} {
  const playCount = parseCount(raw.videoPlayCount);
  if (playCount !== null) return { views: playCount, viewsMetric: "ig_apify_video_play_count" };
  const viewCount = parseCount(raw.videoViewCount);
  if (viewCount !== null) return { views: viewCount, viewsMetric: "ig_apify_video_view_count" };
  return { views: null, viewsMetric: null };
}

export function normalizeApifyInstagram(raw: unknown, context: NormalizeContext): NormalizeResult {
  const parsed = ApifyInstagramPostSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, kind: "INVALID", reason: "raw payload failed Apify Instagram schema validation", issues: parsed.error.issues };
  }
  const post = parsed.data;

  const shortCode = post.shortCode ?? parseInstagramPostUrl(post.url);
  if (!shortCode) {
    return { ok: false, kind: "MISSING_ID", reason: "no usable Instagram shortcode (`shortCode` or parseable `url`) present" };
  }

  const canonicalUrl = buildInstagramCanonicalUrl(shortCode);
  if (!canonicalUrl) {
    return { ok: false, kind: "INVALID_URL", reason: `shortcode "${shortCode}" does not match the expected format` };
  }

  const caption = post.caption ?? null;
  const hashtags = mergeHashtags(post.hashtags ?? [], extractHashtagsFromCaption(caption));
  const { views, viewsMetric } = resolveViews(post);

  const music =
    post.musicInfo && (post.musicInfo.audio_id || post.musicInfo.song_name || post.musicInfo.artist_name)
      ? {
          id: post.musicInfo.audio_id ?? null,
          title: post.musicInfo.song_name ?? null,
          author: post.musicInfo.artist_name ?? null,
        }
      : null;

  return {
    ok: true,
    post: {
      platform: "instagram",
      externalId: shortCode,
      canonicalUrl,
      contentType: resolveContentType(post),
      creator: {
        username: post.ownerUsername ?? null,
        externalId: post.ownerId ?? null,
        // Not exposed anywhere on the post object by this actor — see
        // module comment. Never guessed from another field.
        followers: null,
        verified: null,
      },
      caption,
      hashtags,
      music,
      publishedAt: parseProviderDate(post.timestamp),
      durationSec: parseDuration(post.videoDuration),
      metrics: {
        views,
        viewsMetric,
        likes: parseCount(post.likesCount),
        comments: parseCount(post.commentsCount),
        shares: parseCount(post.reshareCount),
        // Not exposed by this actor.
        saves: null,
      },
      observedAt: context.observedAt,
      source: { provider: "apify", discoveryMethod: context.discoveryMethod ?? null },
    },
  };
}
