/**
 * Builds a frozen `result_view` from CURRENT (not report-frozen) Phase 6
 * state for `/rising`, `/tiktok`, `/instagram`, and the category filter
 * commands (Phase 8 brief §20, §36-41). Reuses the exact same candidate
 * pool, rankability rule, and ranking comparators the daily report uses
 * (`isRankable`, `compareCandidates`, `selectRisingNow`) — no forked
 * qualification/threshold logic (brief §36, §71).
 */
import type { Database } from "@/db/client.ts";
import { getReportCandidatePosts } from "@/db/repositories/report-data.ts";
import { applyAge, isRankable, toReportItem, type CandidatePost } from "@/core/report/build-daily-report.ts";
import { compareCandidates, type TopCandidate } from "@/core/report/select-top.ts";
import { selectRisingNow } from "@/core/report/select-rising.ts";
import type { ReportItem } from "@/core/report/types.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";
import { CATEGORY_PARENTS } from "@/core/domain/category.ts";
import { LIVE_VIEW_MAX_ITEMS, RISING_MAX_AGE_HOURS } from "@/config/telegram.ts";

const CANDIDATE_POOL_HORIZON_HOURS = 72;

function matchesCategory(categories: Category[], filter: Category): boolean {
  if (categories.includes(filter)) return true;
  // /gaming rolls up pc and playstation (brief §40, core/domain/category.ts CATEGORY_PARENTS).
  if (filter === "gaming") return categories.some((c) => CATEGORY_PARENTS[c] === "gaming");
  return false;
}

function toTopCandidate(p: CandidatePost): TopCandidate {
  return {
    postId: p.postId,
    platform: p.platform,
    creatorKey: p.creatorUsername ? `${p.platform}:${p.creatorUsername}` : `${p.platform}:anon:${p.postId}`,
    trendScore: p.trendScore ?? 0,
    risingScore: p.risingScore ?? 0,
    vph: p.vph ?? 0,
    views: p.views ?? 0,
    publishedAtMs: p.publishedAt.getTime(),
  };
}

export interface LiveViewFilter {
  platform?: Platform;
  category?: Category;
  mode: "trend" | "rising";
}

/** Ranked items only — the caller (a command handler) decides the header
 * text and owns the `result_views` write (brief §20-21), since a
 * header's content (e.g. "Data as of HH:MM") is Telegram presentation,
 * not part of computing the ranking itself. */
export async function buildLiveView(db: Database, market: string, now: Date, filter: LiveViewFilter): Promise<ReportItem[]> {
  const candidates = await getReportCandidatePosts(db, market, now, CANDIDATE_POOL_HORIZON_HOURS);
  const rankable = candidates.filter(isRankable);

  const filtered = rankable.filter((p) => {
    if (filter.platform && p.platform !== filter.platform) return false;
    if (filter.category && !matchesCategory(p.categories, filter.category)) return false;
    return true;
  });

  let ranked: CandidatePost[];
  if (filter.mode === "rising") {
    const fresh = filtered.filter((p) => (now.getTime() - p.publishedAt.getTime()) / 3_600_000 <= RISING_MAX_AGE_HOURS);
    const risingCandidates = fresh.map((p) => ({ postId: p.postId, risingScore: p.risingScore ?? 0, vph: p.vph ?? 0, publishedAtMs: p.publishedAt.getTime() }));
    const selectedIds = new Set(selectRisingNow(risingCandidates, LIVE_VIEW_MAX_ITEMS).map((c) => c.postId));
    ranked = fresh.filter((p) => selectedIds.has(p.postId)).sort((a, b) => (b.risingScore ?? 0) - (a.risingScore ?? 0) || a.postId - b.postId);
  } else {
    ranked = [...filtered].sort((a, b) => compareCandidates(toTopCandidate(a), toTopCandidate(b))).slice(0, LIVE_VIEW_MAX_ITEMS);
  }

  return ranked.map((p, i) => applyAge(toReportItem(p, i + 1, "LIVE", false), now, p.publishedAt));
}
