/**
 * Hashtag co-occurrence persistence (Phase 6 brief §34-35). Each upsert
 * SETs the full day's absolute counts for one pair (computed fresh from
 * that day's posts by the caller) rather than incrementing — the same
 * idempotency approach as analytics-hashtags.ts's daily stats, so
 * rerunning analytics for the same day never double-counts (brief §4).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { hashtagCooccurrenceDaily } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";

export interface CooccurrenceUpsert {
  date: string;
  platform: Platform;
  market: string;
  /** Caller guarantees tagAId < tagBId (canonical ordering — see
   * core/analytics/cooccurrence.ts). */
  tagAId: number;
  tagBId: number;
  posts: number;
  viralPosts: number;
  viewsSum: number | null;
}

export async function upsertCooccurrence(db: Database, params: CooccurrenceUpsert): Promise<void> {
  await db
    .insert(hashtagCooccurrenceDaily)
    .values({
      date: params.date,
      platform: params.platform,
      market: params.market,
      tagA: params.tagAId,
      tagB: params.tagBId,
      posts: params.posts,
      viralPosts: params.viralPosts,
      viewsSum: params.viewsSum,
    })
    .onConflictDoUpdate({
      target: [hashtagCooccurrenceDaily.date, hashtagCooccurrenceDaily.platform, hashtagCooccurrenceDaily.market, hashtagCooccurrenceDaily.tagA, hashtagCooccurrenceDaily.tagB],
      set: { posts: params.posts, viralPosts: params.viralPosts, viewsSum: params.viewsSum },
    });
}

export async function getCooccurrenceForTag(db: Database, platform: Platform, market: string, tagId: number, date: string): Promise<{ otherTagId: number; posts: number; viralPosts: number }[]> {
  const rows = await db
    .select({ tagA: hashtagCooccurrenceDaily.tagA, tagB: hashtagCooccurrenceDaily.tagB, posts: hashtagCooccurrenceDaily.posts, viralPosts: hashtagCooccurrenceDaily.viralPosts })
    .from(hashtagCooccurrenceDaily)
    .where(and(eq(hashtagCooccurrenceDaily.platform, platform), eq(hashtagCooccurrenceDaily.market, market), eq(hashtagCooccurrenceDaily.date, date)));
  return rows
    .filter((r) => r.tagA === tagId || r.tagB === tagId)
    .map((r) => ({ otherTagId: r.tagA === tagId ? r.tagB : r.tagA, posts: r.posts, viralPosts: r.viralPosts }));
}
