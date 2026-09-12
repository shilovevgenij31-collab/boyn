/**
 * Normalized content type. Values are chosen to describe what the content
 * actually is, not whether we'll rank it — filtering to video/reel-only
 * happens later (analytics), not at normalization time.
 *
 * "reel" only applies to Instagram (TikTok has no separate reel concept —
 * all TikTok videos normalize to "video"). "carousel" covers Instagram
 * Sidecar posts and TikTok photo slideshows.
 */
export const CONTENT_TYPES = ["video", "reel", "image", "carousel", "unknown"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}
