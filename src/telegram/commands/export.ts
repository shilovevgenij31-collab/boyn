/**
 * `/export` and `/export 7d` (Phase 8 brief §45-47) — Phase 7's in-memory
 * export helpers only, no filesystem dependency, sent straight as
 * Telegram documents. A durable cooldown (app_settings-backed) blocks
 * repeated spam (brief §47).
 */
import type { TelegramCommandContext } from "../context.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { getHashtagDailyStatsHistory } from "@/db/repositories/report-data.ts";
import { getSetting, setSetting } from "@/db/repositories/settings.ts";
import { exportMarkdown } from "@/core/report/export-markdown.ts";
import { exportCsv } from "@/core/report/export-csv.ts";
import { exportJson } from "@/core/report/export-json.ts";
import { exportHashtagHistoryCsv } from "@/core/report/export-hashtag-history.ts";
import { EXPORT_COOLDOWN_MINUTES } from "@/config/telegram.ts";

const EXPORT_COOLDOWN_KEY = "telegram_export_cooldown";
export const NO_REPORT_MESSAGE = "Ежедневный отчёт ещё не сформирован. Попробуйте снова после следующего планового запуска.";
export const COOLDOWN_MESSAGE = `Повторный экспорт пока недоступен. Подождите ${EXPORT_COOLDOWN_MINUTES} мин и попробуйте снова.`;

async function checkAndSetExportCooldown(ctx: TelegramCommandContext, now: Date): Promise<boolean> {
  const last = await getSetting<string>(ctx.db, EXPORT_COOLDOWN_KEY);
  if (last) {
    const elapsedMinutes = (now.getTime() - new Date(last).getTime()) / 60_000;
    if (elapsedMinutes < EXPORT_COOLDOWN_MINUTES) return false;
  }
  await setSetting(ctx.db, EXPORT_COOLDOWN_KEY, now.toISOString(), now);
  return true;
}

export async function handleExport(ctx: TelegramCommandContext, chatId: number, args: string): Promise<void> {
  const now = ctx.clock.now();
  const allowed = await checkAndSetExportCooldown(ctx, now);
  if (!allowed) {
    await ctx.client.sendMessage({ chat_id: chatId, text: COOLDOWN_MESSAGE });
    return;
  }

  if (args.trim() === "7d") {
    await handleExport7d(ctx, chatId, now);
    return;
  }

  const report = await getLatestDailyReport(ctx.db, ctx.market);
  if (!report) {
    await ctx.client.sendMessage({ chat_id: chatId, text: NO_REPORT_MESSAGE });
    return;
  }

  await ctx.client.sendDocument({ chat_id: chatId, filename: `trends-${report.reportDate}.md`, content: exportMarkdown(report), contentType: "text/markdown" });
  await ctx.client.sendDocument({ chat_id: chatId, filename: `trends-${report.reportDate}.csv`, content: exportCsv(report), contentType: "text/csv" });
  await ctx.client.sendDocument({ chat_id: chatId, filename: `trends-${report.reportDate}.json`, content: exportJson(report), contentType: "application/json" });
}

async function handleExport7d(ctx: TelegramCommandContext, chatId: number, now: Date): Promise<void> {
  const sinceDateStr = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);
  const rows = await getHashtagDailyStatsHistory(ctx.db, ctx.market, sinceDateStr);
  const csv = exportHashtagHistoryCsv(rows);
  const dateStr = now.toISOString().slice(0, 10);
  await ctx.client.sendDocument({ chat_id: chatId, filename: `hashtags-7d-${dateStr}.csv`, content: csv, contentType: "text/csv" });
}
