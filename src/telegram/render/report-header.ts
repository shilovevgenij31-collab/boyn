/**
 * `/today` header block (Phase 8 brief §33; Russian localization — Phase
 * 8/9 hotfix §12) — reused verbatim by the automatic DailyReport delivery
 * helper (brief §68) so the two never diverge visually. A PARTIAL report
 * is always shown prominently (brief §35), never silently blended in with
 * a COMPLETE-looking header. "Today" (strict last 24h) and "Still Hot"
 * (24-72h) stay two visually distinct headers/sections — never merged.
 */
import type { DailyReport, MetricDelta } from "@/core/report/types.ts";
import { escapeHtml } from "./escape.ts";
import { formatCompactNumber } from "./format.ts";
import { PLATFORM_LABEL } from "./labels.ts";
import { translatePartialReason } from "./partial-reasons.ts";

function formatDelta(delta: MetricDelta): string {
  if (delta.previous === null || delta.delta === null) return `${delta.current} (нет данных за вчера)`;
  const sign = delta.delta > 0 ? "+" : "";
  const pct = delta.previous === 0 ? null : (delta.delta / delta.previous) * 100;
  return `${sign}${delta.delta}${pct !== null ? ` (${sign}${pct.toFixed(0)}%)` : ""}`;
}

export function renderReportHeader(report: DailyReport): string {
  const lines: string[] = [];
  lines.push(`🔥 <b>Сегодня — последние 24 часа</b> (${escapeHtml(report.reportDate)})`);
  lines.push(`Рынок: ${escapeHtml(report.market)} · окно закрыто в ${new Date(report.window.end).toISOString().slice(11, 16)} UTC`);

  if (report.status === "PARTIAL") {
    const reasons =
      report.partialReasons.length > 0 ? ` — ${report.partialReasons.map((r) => escapeHtml(translatePartialReason(r))).join(", ")}` : "";
    lines.push(`⚠️ <b>Данные неполные</b>${reasons}`);
  } else {
    lines.push("✅ Данные собраны полностью");
  }

  const platformParts = Object.entries(report.collection.postsScannedByPlatform).map(
    ([platform, n]) => `${PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL] ?? platform}: ${formatCompactNumber(n)}`,
  );
  if (platformParts.length > 0) lines.push(`Собрано: ${platformParts.join(" · ")}`);

  lines.push(`Вирусных <b>${report.counts.viralQualified}</b> · Прорывов <b>${report.counts.earlyBreakout}</b>`);

  if (report.comparisons.vsYesterday) {
    lines.push(`Относительно вчера: вирусных ${formatDelta(report.comparisons.vsYesterday.viralQualified)} · прорывов ${formatDelta(report.comparisons.vsYesterday.earlyBreakout)}`);
  }

  const topHashtags = [...report.hashtags.breakout, ...report.hashtags.rising].slice(0, 5);
  if (topHashtags.length > 0) {
    lines.push(`🏷 Хэштеги Radar: ${topHashtags.map((t) => `#${escapeHtml(t.tag)}`).join(" · ")}`);
  }

  if (report.clusters.length > 0) {
    const clusterLine = report.clusters
      .slice(0, 3)
      .map((c) => `${escapeHtml(c.label)} (${c.tags.length} тегов)`)
      .join(" · ");
    lines.push(`🔗 Кластеры тем: ${clusterLine}`);
  }

  return lines.join("\n");
}

export function renderStillHotHeader(report: DailyReport): string {
  return [
    `♨️ <b>Всё ещё в тренде</b> — 24–72 часа · ${escapeHtml(report.reportDate)}`,
    "Посты, которые всё ещё набирают вовлечённость, но уже не попадают в строгое окно «Сегодня» (24 часа).",
  ].join("\n");
}
