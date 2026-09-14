/**
 * `/today` header block (Phase 8 brief §33) — reused verbatim by the
 * automatic DailyReport delivery helper (brief §68) so the two never
 * diverge visually. A PARTIAL report is always shown prominently (brief
 * §35), never silently blended in with a COMPLETE-looking header.
 */
import type { DailyReport, MetricDelta } from "@/core/report/types.ts";
import { escapeHtml } from "./escape.ts";
import { formatCompactNumber } from "./format.ts";

const PLATFORM_LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram" };

function formatDelta(delta: MetricDelta): string {
  if (delta.previous === null || delta.delta === null) return `${delta.current} (no prior data)`;
  const sign = delta.delta > 0 ? "+" : "";
  const pct = delta.previous === 0 ? null : (delta.delta / delta.previous) * 100;
  return `${sign}${delta.delta}${pct !== null ? ` (${sign}${pct.toFixed(0)}%)` : ""}`;
}

export function renderReportHeader(report: DailyReport): string {
  const lines: string[] = [];
  lines.push(`📊 <b>Daily Trend Report — ${escapeHtml(report.reportDate)}</b>`);
  lines.push(`Market: ${escapeHtml(report.market)} · Window ends ${new Date(report.window.end).toISOString().slice(11, 16)} UTC`);

  if (report.status === "PARTIAL") {
    const reasons = report.partialReasons.length > 0 ? ` — ${report.partialReasons.map((r) => escapeHtml(r)).join(", ")}` : "";
    lines.push(`⚠️ <b>PARTIAL DATA</b>${reasons}`);
  } else {
    lines.push("✅ COMPLETE");
  }

  const platformParts = Object.entries(report.collection.postsScannedByPlatform).map(
    ([platform, n]) => `${PLATFORM_LABEL[platform] ?? platform} ${formatCompactNumber(n)}`,
  );
  if (platformParts.length > 0) lines.push(`Collection: ${platformParts.join(" · ")} scanned`);

  lines.push(`Viral <b>${report.counts.viralQualified}</b> · Breakout <b>${report.counts.earlyBreakout}</b>`);

  if (report.comparisons.vsYesterday) {
    lines.push(`vs yesterday: Viral ${formatDelta(report.comparisons.vsYesterday.viralQualified)} · Breakout ${formatDelta(report.comparisons.vsYesterday.earlyBreakout)}`);
  }

  const topHashtags = [...report.hashtags.breakout, ...report.hashtags.rising].slice(0, 5);
  if (topHashtags.length > 0) {
    lines.push(`🏷 Radar hashtags: ${topHashtags.map((t) => `#${escapeHtml(t.tag)}`).join(" · ")}`);
  }

  if (report.clusters.length > 0) {
    const clusterLine = report.clusters
      .slice(0, 3)
      .map((c) => `${escapeHtml(c.label)} (${c.tags.length} tags)`)
      .join(" · ");
    lines.push(`🔗 Clusters: ${clusterLine}`);
  }

  return lines.join("\n");
}

export function renderStillHotHeader(report: DailyReport): string {
  return [`🔥 <b>Still Hot</b> (24-72h old) · ${escapeHtml(report.reportDate)}`, "Currently qualifying posts that missed today's strict 24h window."].join("\n");
}
