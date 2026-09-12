/**
 * Pure TikTok refresh-eligibility/cadence logic (Phase 5 brief §28-31) — a
 * conservative MVP subset of docs/IMPLEMENTATION_PLAN.md §14's full
 * staged/decayed-vph rule, which needs Phase 6 scoring (vph, tier) that
 * doesn't exist yet. The DB query that fetches candidate posts lives in
 * src/db/repositories/posts.ts; this module only decides eligibility/
 * cadence given an already-fetched row.
 *
 * Instagram has no refresh provider (Phase 4 ADR-024) — nothing here is
 * platform-generic; callers only ever run this for tiktok posts.
 */
import { REFRESH_CONFIG } from "@/config/schedule.ts";

export interface RefreshCandidate {
  postId: number;
  publishedAt: Date | null;
  views: number | null;
  paidRefreshCount: number;
  nextRefreshAt: Date | null;
  availability: "ACTIVE" | "DELETED" | "PRIVATE" | "UNKNOWN";
}

/** Whether this post is even a candidate for scheduling a refresh at all
 * (age/views/count/availability gates) — independent of whether it's due
 * right now (see isRefreshDue). Used when a post is first discovered, to
 * decide whether to give it an initial nextRefreshAt at all. */
export function isRefreshEligible(post: RefreshCandidate, now: Date): boolean {
  if (post.availability !== "ACTIVE") return false;
  if (post.paidRefreshCount >= REFRESH_CONFIG.maxPaidRefreshCount) return false;
  if (post.views === null || post.views < REFRESH_CONFIG.minViews) return false;
  if (post.publishedAt === null) return false;
  const ageHours = (now.getTime() - post.publishedAt.getTime()) / 3_600_000;
  if (ageHours < 0 || ageHours > REFRESH_CONFIG.maxAgeHours) return false;
  return true;
}

/** Eligible AND due right now (nextRefreshAt unset or in the past). */
export function isRefreshDue(post: RefreshCandidate, now: Date): boolean {
  if (!isRefreshEligible(post, now)) return false;
  return post.nextRefreshAt === null || post.nextRefreshAt.getTime() <= now.getTime();
}

/** Next refresh time after a successful refresh at `now` — a flat step
 * cadence (§29: "conservative MVP cadence", not the full decayed-interval
 * rule from §14, which needs Phase 6 vph). */
export function computeNextRefreshAt(now: Date): Date {
  return new Date(now.getTime() + REFRESH_CONFIG.refreshStepHours * 3_600_000);
}
