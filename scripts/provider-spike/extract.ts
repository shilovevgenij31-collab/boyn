/**
 * Per-combination field extraction from RAW provider records.
 *
 * IMPORTANT: the candidate field names below are our best current guess
 * from documentation researched during planning — NOT confirmed against a
 * live account for every dataset/actor (Bright Data in particular
 * configures dataset schemas per listing; the true field names should be
 * cross-checked against the account's own dataset "API" tab on first real
 * run). Listing multiple candidates per logical attribute, and reporting
 * which one actually matched, is exactly how this spike is supposed to
 * surface that gap rather than silently assuming.
 */
import type { CombinationKey } from "./types.ts";

export interface FieldCandidates {
  id: string[];
  url: string[];
  username: string[];
  publishedAt: string[];
  views: string[];
  likes: string[];
  comments: string[];
  shares: string[];
  caption: string[];
  hashtags: string[];
  musicTitle: string[];
  duration: string[];
  followerCount: string[];
  verified: string[];
}

export const FIELD_CANDIDATES: Record<CombinationKey, FieldCandidates> = {
  brightdata_tiktok: {
    id: ["post_id", "id", "aweme_id"],
    url: ["url", "web_url", "video_url"],
    username: ["user_posted", "username", "author"],
    publishedAt: ["date_posted", "create_time", "createTime"],
    views: ["views", "play_count", "video_play_count"],
    likes: ["likes", "digg_count"],
    comments: ["num_comments", "comment_count", "comments"],
    shares: ["shares", "share_count"],
    caption: ["description", "caption", "title"],
    hashtags: ["hashtags"],
    musicTitle: ["music_title", "song"],
    duration: ["video_duration", "duration"],
    followerCount: ["followers", "author_followers"],
    verified: ["is_verified", "verified"],
  },
  brightdata_instagram: {
    id: ["post_id", "id", "shortcode"],
    url: ["url"],
    username: ["user_posted", "username"],
    publishedAt: ["date_posted", "timestamp"],
    views: ["views", "video_view_count", "video_play_count"],
    likes: ["likes"],
    comments: ["num_comments", "comments"],
    shares: ["shares", "reshare_count"],
    caption: ["description", "caption"],
    hashtags: ["hashtags"],
    musicTitle: ["music_title"],
    duration: ["video_duration"],
    followerCount: ["followers"],
    verified: ["is_verified"],
  },
  apify_tiktok: {
    id: ["id", "videoId"],
    url: ["webVideoUrl", "url"],
    username: ["authorMeta.name", "authorMeta.uniqueId", "author"],
    publishedAt: ["createTimeISO", "createTime"],
    views: ["playCount"],
    likes: ["diggCount"],
    comments: ["commentCount"],
    shares: ["shareCount"],
    caption: ["text", "description"],
    hashtags: ["hashtags"],
    musicTitle: ["musicMeta.musicName"],
    duration: ["videoMeta.duration", "duration"],
    followerCount: ["authorMeta.fans", "authorMeta.followerCount"],
    verified: ["authorMeta.verified"],
  },
  apify_instagram: {
    id: ["id", "shortCode"],
    url: ["url"],
    username: ["ownerUsername"],
    publishedAt: ["timestamp"],
    views: ["videoPlayCount", "videoViewCount"],
    likes: ["likesCount"],
    comments: ["commentsCount"],
    shares: ["reshareCount"],
    caption: ["caption"],
    hashtags: ["hashtags"],
    musicTitle: ["musicInfo.song_name"],
    duration: ["videoDuration"],
    followerCount: [],
    verified: [],
  },
};

/** Every candidate field path for a combination, flattened, for the field
 * coverage table — each candidate is reported on its own so we can see
 * exactly which one a real account actually populates. */
export function allCandidateFieldPaths(candidates: FieldCandidates): string[] {
  return [
    ...candidates.id,
    ...candidates.url,
    ...candidates.username,
    ...candidates.publishedAt,
    ...candidates.views,
    ...candidates.likes,
    ...candidates.comments,
    ...candidates.shares,
    ...candidates.caption,
    ...candidates.hashtags,
    ...candidates.musicTitle,
    ...candidates.duration,
    ...candidates.followerCount,
    ...candidates.verified,
  ];
}

export function getPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

export interface FirstMatch {
  field: string | null;
  value: unknown;
}

/** Returns the first candidate field (in priority order) that is present
 * on this specific record, plus its raw value. `field: null` means none of
 * the candidates were present on this record. */
export function firstPresent(record: Record<string, unknown>, candidates: string[]): FirstMatch {
  for (const field of candidates) {
    const value = getPath(record, field);
    if (isPresent(value)) return { field, value };
  }
  return { field: null, value: undefined };
}

/** Parses a timestamp value that might be an ISO string, unix seconds, or
 * unix milliseconds (all observed across social scraper APIs). Returns
 * null (never a fabricated date) if it can't be confidently parsed. */
export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    // Heuristic: 10-digit ~ seconds, 13-digit ~ milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return parseTimestamp(Number(trimmed));
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
