/**
 * `trends-YYYY-MM-DD.csv` (Phase 7 brief §38-39): the frozen
 * `exportCandidates` pool, one flat row per post, UTF-8 with BOM. Null
 * provider metrics stay empty cells — never rewritten as 0.
 */
import type { DailyReport } from "./types.ts";
import { buildCsv } from "./csv-utils.ts";

const HEADERS = [
  "rank",
  "qualification",
  "trend_state",
  "platform",
  "creator",
  "published_at",
  "age_hours",
  "views",
  "likes",
  "comments",
  "shares",
  "vph",
  "vph_kind",
  "velocity_confidence",
  "trend_score",
  "rising_score",
  "categories",
  "hashtags",
  "caption",
  "canonical_url",
];

export function exportCsv(report: DailyReport): string {
  const rows = report.exportCandidates.map((item) => [
    item.rank,
    item.tier ?? "",
    item.trendState ?? "",
    item.platform,
    item.creatorUsername ?? "",
    item.publishedAt ?? "",
    item.ageHours !== null ? item.ageHours.toFixed(2) : "",
    item.views ?? "",
    item.likes ?? "",
    item.comments ?? "",
    item.shares ?? "",
    item.vph !== null ? item.vph.toFixed(2) : "",
    item.vphKind,
    item.velocityConfidence ?? "",
    item.trendScore ?? "",
    item.risingScore ?? "",
    item.categories.join("|"),
    item.hashtags.join("|"),
    item.captionPreview ?? "",
    item.canonicalUrl,
  ]);
  return buildCsv(HEADERS, rows);
}
