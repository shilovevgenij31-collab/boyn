/**
 * 7-day hashtag history CSV (Phase 7 brief §41) — the core export for a
 * future `/export 7d` Telegram command (not built here). Source is
 * `hashtag_daily_stats` rows, already fetched by the caller. Column
 * names use "radar"/plain wording, never implying platform-wide volume
 * (CLAUDE.md rule 13).
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { TrendState } from "@/core/domain/tracking.ts";
import { buildCsv } from "./csv-utils.ts";

export interface HashtagHistoryRow {
  date: string;
  platform: Platform;
  market: string;
  tag: string;
  trendState: TrendState | null;
  radarMomentum: number | null;
  radarPostsSeen: number;
  qualifiedPosts: number;
  breakoutPosts: number;
  distinctCreators: number;
  medianVph: number | null;
  scans: number;
}

const HEADERS = ["date", "platform", "market", "tag", "trend_state", "radar_momentum", "radar_posts_seen", "qualified_posts", "breakout_posts", "distinct_creators", "median_vph", "scans"];

export function exportHashtagHistoryCsv(rows: HashtagHistoryRow[]): string {
  const dataRows = rows.map((r) => [
    r.date,
    r.platform,
    r.market,
    r.tag,
    r.trendState ?? "",
    r.radarMomentum !== null ? r.radarMomentum.toFixed(5) : "",
    r.radarPostsSeen,
    r.qualifiedPosts,
    r.breakoutPosts,
    r.distinctCreators,
    r.medianVph !== null ? r.medianVph.toFixed(2) : "",
    r.scans,
  ]);
  return buildCsv(HEADERS, dataRows);
}
