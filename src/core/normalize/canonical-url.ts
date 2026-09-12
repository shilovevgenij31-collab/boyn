/**
 * Original-platform canonical URL construction. This module is the single
 * place that decides whether a link is trustworthy enough to send a user
 * to — the whole product depends on these always resolving to an actual
 * tiktok.com/instagram.com post, never a provider/CDN URL (CLAUDE.md rule 12).
 *
 * Strategy: prefer RECONSTRUCTING the URL from validated parts (handle +
 * id, or shortcode) over trusting a raw provider URL string verbatim. This
 * deterministically strips tracking/query params and rejects anything that
 * isn't actually shaped like a platform permalink, rather than trying to
 * sanitize an arbitrary string.
 *
 * Real fixture evidence:
 *   - TikTok URLs (both providers) are shaped
 *     `https://www.tiktok.com/@{handle}/video/{id}`.
 *   - Bright Data's `profile_username` field is a DISPLAY NICKNAME
 *     ("Iris ♡︎"), NOT the handle — the real handle only appears in the
 *     URL path (`profile_url` / `url`: ".../@irisinribbons/..."). Apify's
 *     `authorMeta.name` IS the real handle. Because of this inconsistency,
 *     the handle is always taken from a URL path here, never from a
 *     provider's "username" field directly.
 *   - Instagram URLs use `/p/{shortCode}/` even for actual Reels (Apify's
 *     `resultsType: "reels"` still returned `/p/...` permalinks in every
 *     Phase 1 sample) — so canonical Instagram URLs always use `/p/`,
 *     never `/reel/`, regardless of contentType.
 */

const TIKTOK_HANDLE_PATTERN = /^[\w.-]{1,80}$/;
const TIKTOK_ID_PATTERN = /^\d{5,25}$/;
const TIKTOK_VIDEO_PATH = /^\/@([\w.-]{1,80})\/video\/(\d{5,25})\/?$/;
const TIKTOK_PROFILE_PATH = /^\/@([\w.-]{1,80})\/?$/;

const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,20}$/;
const INSTAGRAM_POST_PATH = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,20})(?:\/.*)?$/;

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

function tryParseUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export interface TikTokUrlParts {
  handle: string;
  id: string;
}

/** Parses a TikTok video permalink (`https://www.tiktok.com/@handle/video/id`).
 * Returns null for any other host or path shape — CDN URLs, share links,
 * short links, non-TikTok hosts, etc. are all rejected here by construction. */
export function parseTikTokVideoUrl(raw: string | null | undefined): TikTokUrlParts | null {
  const url = tryParseUrl(raw);
  if (!url || normalizedHost(url) !== "tiktok.com") return null;
  const match = TIKTOK_VIDEO_PATH.exec(url.pathname);
  return match ? { handle: match[1]!, id: match[2]! } : null;
}

/** Parses a TikTok profile URL (`https://www.tiktok.com/@handle`) — used
 * as a fallback handle source when a video URL isn't available/parseable. */
export function parseTikTokProfileUrl(raw: string | null | undefined): string | null {
  const url = tryParseUrl(raw);
  if (!url || normalizedHost(url) !== "tiktok.com") return null;
  const match = TIKTOK_PROFILE_PATH.exec(url.pathname);
  return match ? match[1]! : null;
}

/** Builds a canonical TikTok URL from already-validated parts. Returns
 * null (never a best-effort malformed URL) if either part fails its own
 * format check. */
export function buildTikTokCanonicalUrl(handle: string, externalId: string): string | null {
  if (!TIKTOK_HANDLE_PATTERN.test(handle) || !TIKTOK_ID_PATTERN.test(externalId)) return null;
  return `https://www.tiktok.com/@${handle}/video/${externalId}`;
}

/** Parses an Instagram post/reel permalink and returns its shortcode.
 * Accepts /p/, /reel/, /reels/, /tv/ (all valid Instagram permalink forms
 * for the same content); canonicalization always normalizes to /p/. */
export function parseInstagramPostUrl(raw: string | null | undefined): string | null {
  const url = tryParseUrl(raw);
  if (!url || normalizedHost(url) !== "instagram.com") return null;
  const match = INSTAGRAM_POST_PATH.exec(url.pathname);
  return match ? match[1]! : null;
}

export function buildInstagramCanonicalUrl(shortCode: string): string | null {
  if (!INSTAGRAM_SHORTCODE_PATTERN.test(shortCode)) return null;
  return `https://www.instagram.com/p/${shortCode}/`;
}
