/**
 * Today Top-N selection (Phase 7 brief §10-14): deterministic TrendScore
 * ranking with a per-creator cap and a per-platform floor that is a
 * floor, never a padding quota. Pure — the caller decides which
 * candidates are even eligible (window, qualification, availability);
 * this only decides which of them fit the 30 slots.
 *
 * Algorithm (brief §14), two passes over one globally-sorted list:
 *   1. Platform floor pass: for each platform, walk its own candidates
 *      (already in global sort order) and admit up to
 *      min(available-for-that-platform, floor), skipping any that would
 *      violate the creator cap.
 *   2. Fill pass: walk the FULL sorted list again and admit whatever's
 *      left, up to `max` total, again respecting the cap — this is what
 *      lets a stronger platform take more than its floor once every
 *      platform's floor need has been served.
 * The final result is re-sorted by the same comparator before ranks are
 * assigned, so admission order never leaks into display order.
 */
import type { Platform } from "@/core/domain/platform.ts";

export interface TopCandidate {
  postId: number;
  platform: Platform;
  /** Platform-qualified creator identity (brief §12): "@alex" on TikTok
   * and "@alex" on Instagram must never share a cap slot. A null/unknown
   * username should already be turned into a per-post-unique key by the
   * caller (e.g. `${platform}:unknown:${postId}`) so unrelated anonymous
   * creators are never grouped together. */
  creatorKey: string;
  trendScore: number;
  risingScore: number;
  vph: number;
  views: number;
  publishedAtMs: number;
}

export interface SelectTopConfig {
  max: number;
  maxPerCreator: number;
  platformFloor: number;
}

/** Exported for Phase 8: Telegram's current (non-report) views —
 * `/tiktok`, `/instagram`, category filters — need the exact same
 * deterministic TrendScore ranking, not a forked copy of it. */
export function compareCandidates(a: TopCandidate, b: TopCandidate): number {
  if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
  if (b.risingScore !== a.risingScore) return b.risingScore - a.risingScore;
  if (b.vph !== a.vph) return b.vph - a.vph;
  if (b.views !== a.views) return b.views - a.views;
  if (b.publishedAtMs !== a.publishedAtMs) return b.publishedAtMs - a.publishedAtMs;
  return a.postId - b.postId; // ascending: fully deterministic even if every other field ties
}

export function selectTodayTop<T extends TopCandidate>(candidates: T[], config: SelectTopConfig): T[] {
  const sorted = [...candidates].sort(compareCandidates);

  const byPlatform = new Map<Platform, T[]>();
  for (const c of sorted) {
    const list = byPlatform.get(c.platform);
    if (list) list.push(c);
    else byPlatform.set(c.platform, [c]);
  }

  const selectedIds = new Set<number>();
  const creatorCount = new Map<string, number>();
  const selected: T[] = [];

  function tryAdd(c: T): boolean {
    if (selectedIds.has(c.postId)) return false;
    if (selected.length >= config.max) return false;
    const count = creatorCount.get(c.creatorKey) ?? 0;
    if (count >= config.maxPerCreator) return false;
    selected.push(c);
    selectedIds.add(c.postId);
    creatorCount.set(c.creatorKey, count + 1);
    return true;
  }

  // Pass 1: platform floor (best-effort — never a hard constraint).
  for (const list of byPlatform.values()) {
    const target = Math.min(list.length, config.platformFloor);
    let addedForPlatform = 0;
    for (const c of list) {
      if (addedForPlatform >= target) break;
      if (tryAdd(c)) addedForPlatform += 1;
    }
  }

  // Pass 2: fill remaining slots by global quality, any platform.
  for (const c of sorted) {
    if (selected.length >= config.max) break;
    tryAdd(c);
  }

  return selected.sort(compareCandidates);
}
