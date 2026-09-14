/**
 * `/today` (Phase 8 brief §33-34): the latest frozen DailyReport's header
 * + strict-24h Today Top 30, paginated. Still Hot (24-72h) is exposed as
 * a separate button — never merged into the Today Top pagination (brief
 * §34, plan §19 / ADR-019).
 */
import type { TelegramCommandContext } from "../context.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { createResultView } from "@/db/repositories/result-views.ts";
import { RESULT_VIEW_TTL_DAYS } from "@/config/telegram.ts";
import { renderReportHeader } from "../render/report-header.ts";
import { sendPaginatedView } from "./shared.ts";

export const NO_REPORT_MESSAGE = "No daily report has been generated yet. Try again after the next scheduled run.";

export async function handleToday(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const report = await getLatestDailyReport(ctx.db, ctx.market);
  if (!report) {
    await ctx.client.sendMessage({ chat_id: chatId, text: NO_REPORT_MESSAGE, disable_web_page_preview: true });
    return;
  }

  const header = `${renderReportHeader(report)}\n\n<b>Today Top ${report.todayTop.length}</b>`;
  const viewId = await createResultView(ctx.db, { kind: "today", headerText: header, extra: { reportDate: report.reportDate, market: report.market }, items: report.todayTop, createdAt: ctx.clock.now(), ttlDays: RESULT_VIEW_TTL_DAYS });
  await sendPaginatedView(ctx, chatId, viewId, report.todayTop, header);

  if (report.stillHot.length > 0) {
    await ctx.client.sendMessage({
      chat_id: chatId,
      text: `🔥 ${report.stillHot.length} more posts are Still Hot (24-72h old) — tap below to see them.`,
      reply_markup: { inline_keyboard: [[{ text: "🔥 Show Still Hot", callback_data: `sh:${report.reportDate}` }]] },
    });
  }
}
