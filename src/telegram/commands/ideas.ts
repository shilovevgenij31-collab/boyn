/**
 * `/ideas` (Phase 8 brief §48; Russian localization — Phase 8/9 hotfix
 * §16) — deterministic, metadata-only summary from the latest frozen
 * DailyReport's clusters/hashtags. NO LLM, NO OpenRouter (brief §89) —
 * this is plain string formatting over already-persisted structured
 * data, clearly labeled as such.
 */
import type { TelegramCommandContext } from "../context.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { escapeHtml } from "../render/escape.ts";
import { enforceMessageLimit } from "../render/page.ts";

export const NO_REPORT_MESSAGE = "Ежедневный отчёт ещё не сформирован. Попробуйте снова после следующего планового запуска.";

export async function handleIdeas(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const report = await getLatestDailyReport(ctx.db, ctx.market);
  if (!report) {
    await ctx.client.sendMessage({ chat_id: chatId, text: NO_REPORT_MESSAGE });
    return;
  }

  const lines: string[] = ["<b>Главные наблюдаемые темы за сегодня</b>", "(анализ метаданных — только подписи/хэштеги/метрики; бот не просматривал сами видео)"];

  if (report.clusters.length === 0) {
    lines.push("", "Сегодня недостаточно данных для выделения кластеров хэштегов.");
  } else {
    lines.push("");
    report.clusters.slice(0, 5).forEach((cluster, i) => {
      const tags = cluster.tags.map((t) => `#${escapeHtml(t)}`).join(" ");
      const refs = cluster.sampleRanks.length > 0 ? ` — примеры постов: ${cluster.sampleRanks.map((r) => `#${r}`).join(", ")}` : "";
      lines.push(`${i + 1}. <b>${escapeHtml(cluster.label)}</b> (качественных постов: ${cluster.qualifiedPosts}) · ${tags}${refs}`);
    });
  }

  const radarTags = [...report.hashtags.breakout, ...report.hashtags.rising].slice(0, 8);
  if (radarTags.length > 0) {
    lines.push("", `Хэштеги Radar: ${radarTags.map((t) => `#${escapeHtml(t.tag)}`).join(" ")}`);
  }

  lines.push("", "<i>Это анализ метаданных; бот не просматривал сами видео. Там, где показана скорость роста, отличайте измеренную от оценочной — AI здесь не использовался.</i>");

  await ctx.client.sendMessage({ chat_id: chatId, text: enforceMessageLimit(lines.join("\n")), parse_mode: "HTML", disable_web_page_preview: true });
}
