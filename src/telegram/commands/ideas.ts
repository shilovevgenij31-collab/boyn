/**
 * `/ideas` (Phase 8 brief §48) — deterministic, metadata-only summary
 * from the latest frozen DailyReport's clusters/hashtags. NO LLM, NO
 * OpenRouter (brief §89) — this is plain string formatting over already-
 * persisted structured data, clearly labeled as such.
 */
import type { TelegramCommandContext } from "../context.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { escapeHtml } from "../render/escape.ts";
import { enforceMessageLimit } from "../render/page.ts";

export const NO_REPORT_MESSAGE = "No daily report has been generated yet. Try again after the next scheduled run.";

export async function handleIdeas(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const report = await getLatestDailyReport(ctx.db, ctx.market);
  if (!report) {
    await ctx.client.sendMessage({ chat_id: chatId, text: NO_REPORT_MESSAGE });
    return;
  }

  const lines: string[] = ["<b>Top observed themes today</b>", "(metadata-based summary — captions/hashtags/metrics only; the system did not watch any video)"];

  if (report.clusters.length === 0) {
    lines.push("", "No hashtag clusters had enough evidence today.");
  } else {
    lines.push("");
    report.clusters.slice(0, 5).forEach((cluster, i) => {
      const tags = cluster.tags.map((t) => `#${escapeHtml(t)}`).join(" ");
      const refs = cluster.sampleRanks.length > 0 ? ` — representative posts: ${cluster.sampleRanks.map((r) => `#${r}`).join(", ")}` : "";
      lines.push(`${i + 1}. <b>${escapeHtml(cluster.label)}</b> (${cluster.qualifiedPosts} qualified posts) · ${tags}${refs}`);
    });
  }

  const radarTags = [...report.hashtags.breakout, ...report.hashtags.rising].slice(0, 8);
  if (radarTags.length > 0) {
    lines.push("", `Radar hashtags: ${radarTags.map((t) => `#${escapeHtml(t.tag)}`).join(" ")}`);
  }

  lines.push("", "<i>Deterministic metadata summary. Distinguish OBSERVED vs ESTIMATED velocity where shown elsewhere — no AI was used to produce this.</i>");

  await ctx.client.sendMessage({ chat_id: chatId, text: enforceMessageLimit(lines.join("\n")), parse_mode: "HTML", disable_web_page_preview: true });
}
