/**
 * `trends-YYYY-MM-DD.md` (Phase 7 brief §35-37) — the primary manual
 * ChatGPT Pro upload artifact. Plain Markdown text built entirely from
 * the frozen DailyReport; no AI call of any kind (brief §36/§70).
 */
import type { DailyReport, ReportItem, TagItem } from "./types.ts";

const ANALYSIS_PROMPT = `You are analyzing a snapshot of short-form video metadata (TikTok/Instagram) captured by an automated radar system. Using ONLY the data below:

- Identify content concepts/themes that appear to be gaining momentum right now.
- Distinguish OBSERVED velocity (measured from real repeated snapshots) from ESTIMATED velocity (a single-point extrapolation) — treat ESTIMATED numbers as lower-confidence.
- Base every observation strictly on the supplied captions, hashtags, and metrics. Do NOT claim to have watched any video, seen any thumbnail, or accessed anything beyond this text.
- When making a recommendation, cite the specific post rank(s) and/or URL(s) that support it.
- "Radar momentum" below reflects growth inside this system's own small monitored sample of tracked hashtags — never the whole platform. Do not restate it as a platform-wide trend.`;

function escapePipes(text: string | null): string {
  if (text === null) return "";
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatVph(item: ReportItem): string {
  if (item.vph === null) return "—";
  const suffix = item.vphKind === "ESTIMATED" ? " est." : "";
  return `${Math.round(item.vph).toLocaleString("en-US")}/h${suffix}`;
}

function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function itemRow(item: ReportItem): string {
  return `| ${item.rank} | ${item.platform} | ${item.creatorUsername ?? "—"} | ${formatMetric(item.views)} | ${formatVph(item)} | ${item.ageHours !== null ? item.ageHours.toFixed(1) + "h" : "—"} | ${item.trendScore ?? "—"} | ${item.hashtags.map((h) => `#${h}`).join(" ")} | ${escapePipes(item.captionPreview)} | [link](${item.canonicalUrl}) |`;
}

function itemsTable(items: ReportItem[]): string {
  if (items.length === 0) return "_None._\n";
  const header = "| Rank | Platform | Creator | Views | VPH | Age | TrendScore | Tags | Caption | URL |\n|---|---|---|---|---|---|---|---|---|---|";
  return [header, ...items.map(itemRow)].join("\n") + "\n";
}

function tagRow(tag: TagItem): string {
  return `| #${tag.tag} | ${tag.platform} | ${tag.trendState} | ${tag.radarPosts24h} | ${tag.qualifiedPosts24h} | ${tag.distinctCreators24h} | ${tag.medianVph !== null ? Math.round(tag.medianVph).toLocaleString("en-US") : "—"} | ${tag.radarMomentum !== null ? tag.radarMomentum.toFixed(3) : "—"} |`;
}

function tagsTable(tags: TagItem[]): string {
  if (tags.length === 0) return "_None._\n";
  const header = "| Tag | Platform | State | Radar posts (24h) | Qualified | Distinct creators | Median VPH | Radar momentum |\n|---|---|---|---|---|---|---|---|";
  return [header, ...tags.map(tagRow)].join("\n") + "\n";
}

export function exportMarkdown(report: DailyReport): string {
  const sections: string[] = [];

  sections.push(`# Trend Radar — ${report.reportDate} (${report.market})\n`);
  sections.push("## Analysis prompt (paste into ChatGPT Pro along with this file)\n");
  sections.push("```\n" + ANALYSIS_PROMPT + "\n```\n");

  sections.push("## Status\n");
  sections.push(`**${report.status}**${report.partialReasons.length > 0 ? ` — ${report.partialReasons.join(", ")}` : ""}\n`);
  sections.push(`Window: ${report.window.start} → ${report.window.end} (${report.timezone})  \nGenerated: ${report.generatedAt}  \nScoring version: ${report.scoringVersion}\n`);

  sections.push("## Metric definitions\n");
  sections.push(
    [
      "- **TrendScore** — overall ranking score (0-100) combining velocity, reach, engagement, freshness, hashtag momentum, and acceleration. Missing inputs are dropped and the rest reweighted, never treated as zero.",
      "- **RisingScore** — a separate 0-100 score weighted toward *current* velocity and acceleration, for surfacing early breakouts before reach dominates.",
      "- **VPH** — views per hour. **OBSERVED** = measured from real repeated snapshots (trustworthy). **ESTIMATED** = a single-point extrapolation from age (lower confidence) — always shown with an \"est.\" suffix above.",
      "- **Velocity confidence** — HIGH (2+ observed intervals), MEDIUM (1 observed interval), LOW (estimated only).",
      "- **Radar momentum / Radar posts** — growth and volume observed inside this system's own small, budgeted sample of tracked hashtags. **Never a platform-wide TikTok/Instagram statistic.**",
      "- **Trend states** — BREAKOUT/RISING/ACTIVE/STABLE/FALLING/DEAD describe current momentum, separate from the VIRAL_QUALIFIED/EARLY_BREAKOUT/WATCH qualification tier.",
    ].join("\n") + "\n",
  );

  sections.push("## Collection overview\n");
  const c = report.collection;
  sections.push(
    `Runs: ${c.runs} (failed ${c.runsFailed}, partial ${c.runsPartial}) · Posts scanned: ${c.postsScannedTotal} (TikTok ${c.postsScannedByPlatform.tiktok}, Instagram ${c.postsScannedByPlatform.instagram}) · Unique: ${c.uniquePosts} · New: ${c.newPosts} · Snapshots: ${c.snapshots} · Records used: ${c.recordsUsed} · Est. cost: $${c.estCostUsd.toFixed(2)} · Tags scanned: ${c.tagsScanned}\n`,
  );
  sections.push(`Counts (today window): VIRAL_QUALIFIED ${report.counts.viralQualified} · EARLY_BREAKOUT ${report.counts.earlyBreakout} · WATCH ${report.counts.watch}\n`);

  if (report.comparisons.vsYesterday) {
    const v = report.comparisons.vsYesterday;
    sections.push(
      `vs. yesterday: VIRAL_QUALIFIED ${v.viralQualified.current} (${v.viralQualified.delta === null ? "n/a" : (v.viralQualified.delta >= 0 ? "+" : "") + v.viralQualified.delta}) · EARLY_BREAKOUT ${v.earlyBreakout.current} (${v.earlyBreakout.delta === null ? "n/a" : (v.earlyBreakout.delta >= 0 ? "+" : "") + v.earlyBreakout.delta})\n`,
    );
  }

  sections.push("## Hashtags — Radar momentum (observed in our monitored sample only)\n");
  sections.push("### Breakout\n" + tagsTable(report.hashtags.breakout));
  sections.push("### Rising\n" + tagsTable(report.hashtags.rising));
  sections.push("### Top by qualified posts\n" + tagsTable(report.hashtags.topByQualifiedPosts));
  if (report.hashtags.newlyTracked.length > 0) sections.push(`Newly tracked: ${report.hashtags.newlyTracked.map((t) => `#${t}`).join(", ")}\n`);
  if (report.hashtags.demoted.length > 0) sections.push(`Demoted: ${report.hashtags.demoted.map((t) => `#${t}`).join(", ")}\n`);

  if (report.clusters.length > 0) {
    sections.push("## Clusters\n");
    for (const cluster of report.clusters) {
      sections.push(`- **${cluster.label}**: ${cluster.tags.map((t) => `#${t}`).join(" ")} — ${cluster.qualifiedPosts} qualified posts${cluster.viewsSum !== null ? `, ${cluster.viewsSum.toLocaleString("en-US")} views` : ""}\n`);
    }
  }

  sections.push(`## Today Top ${report.todayTop.length} (published in the last 24h)\n`);
  sections.push(itemsTable(report.todayTop));

  sections.push(`## Still Hot (24-72h old, still qualifying)\n`);
  sections.push(itemsTable(report.stillHot));

  sections.push(`## Rising Now (ranked by RisingScore, any age within window)\n`);
  sections.push(itemsTable(report.risingNow));

  return sections.join("\n");
}
