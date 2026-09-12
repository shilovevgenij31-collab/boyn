import type { NormalizeContext, NormalizeResult } from "@/core/domain/social-post.ts";
import type { ContentType } from "@/core/domain/content-type.ts";
import { buildTikTokCanonicalUrl, parseTikTokVideoUrl } from "@/core/normalize/canonical-url.ts";
import { extractHashtagsFromCaption, extractRawHashtagNames, mergeHashtags } from "@/core/normalize/hashtags.ts";
import { parseCount, parseDuration } from "@/core/normalize/numbers.ts";
import { parseProviderDate } from "@/core/normalize/dates.ts";
import { ApifyTikTokPostSchema } from "./schema-tiktok.ts";

function resolveContentType(raw: { isSlideshow?: boolean }): ContentType {
  return raw.isSlideshow === true ? "carousel" : "video";
}

/** Resolves the TikTok handle + externalId together: the handle is always
 * taken from a URL, never from a "username"-labeled field (see
 * canonical-url.ts module comment for why — Apify's authorMeta.name is a
 * real handle, but it's still safer/uniform to derive it the same way for
 * every provider rather than trust a per-provider field name). */
function resolveHandle(raw: { webVideoUrl?: string; authorMeta?: { name?: string; uniqueId?: string } }): string | null {
  const fromVideoUrl = parseTikTokVideoUrl(raw.webVideoUrl)?.handle;
  if (fromVideoUrl) return fromVideoUrl;
  return raw.authorMeta?.uniqueId ?? raw.authorMeta?.name ?? null;
}

export function normalizeApifyTikTok(raw: unknown, context: NormalizeContext): NormalizeResult {
  const parsed = ApifyTikTokPostSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, kind: "INVALID", reason: "raw payload failed Apify TikTok schema validation", issues: parsed.error.issues };
  }
  const post = parsed.data;

  const externalId = post.id !== undefined ? String(post.id) : null;
  if (!externalId || !/^\d{5,25}$/.test(externalId)) {
    return { ok: false, kind: "MISSING_ID", reason: "no valid numeric TikTok video id (`id`) present" };
  }

  const handle = resolveHandle(post);
  const canonicalUrl = handle ? buildTikTokCanonicalUrl(handle, externalId) : null;
  if (!canonicalUrl) {
    return { ok: false, kind: "INVALID_URL", reason: "could not construct a canonical tiktok.com URL (no usable handle/webVideoUrl)" };
  }

  const caption = post.text ?? null;
  const hashtags = mergeHashtags(extractRawHashtagNames(post.hashtags), extractHashtagsFromCaption(caption));

  const views = parseCount(post.playCount);

  const music =
    post.musicMeta && (post.musicMeta.musicId || post.musicMeta.musicName || post.musicMeta.musicAuthor)
      ? {
          id: post.musicMeta.musicId ?? null,
          title: post.musicMeta.musicName ?? null,
          author: post.musicMeta.musicAuthor ?? null,
        }
      : null;

  return {
    ok: true,
    post: {
      platform: "tiktok",
      externalId,
      canonicalUrl,
      contentType: resolveContentType(post),
      creator: {
        username: handle,
        externalId: post.authorMeta?.id ?? null,
        followers: parseCount(post.authorMeta?.fans),
        verified: post.authorMeta?.verified ?? null,
      },
      caption,
      hashtags,
      music,
      publishedAt: parseProviderDate(post.createTimeISO ?? post.createTime),
      durationSec: parseDuration(post.videoMeta?.duration),
      metrics: {
        views,
        viewsMetric: views !== null ? "tt_apify_play_count" : null,
        likes: parseCount(post.diggCount),
        comments: parseCount(post.commentCount),
        shares: parseCount(post.shareCount),
        saves: parseCount(post.collectCount),
      },
      observedAt: context.observedAt,
      source: { provider: "apify", discoveryMethod: context.discoveryMethod ?? null },
    },
  };
}
