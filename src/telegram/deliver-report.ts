/**
 * Automatic DailyReport delivery (Phase 8 brief §65-68): a frozen report
 * -> Telegram messages, sent to `TELEGRAM_REPORT_CHAT_ID`. Reuses the
 * exact same renderers `/today` uses (renderReportHeader, renderPage) —
 * brief §68's "must reuse the same renderers, never two diverging visual
 * formats" — and never regenerates the report itself.
 *
 * Idempotency (brief §66-67): each "piece" (the main paginated message,
 * the Still Hot prompt) is recorded into `daily_reports.
 * telegram_message_ids` the moment it's actually sent, and `delivered_at`
 * is only ever set after every applicable piece is confirmed present. A
 * retry re-reads that array first and skips whatever's already there, so
 * a crash mid-delivery resumes cleanly instead of re-sending everything.
 */
import type { TelegramCommandContext } from "./context.ts";
import { appendDeliveredPiece, getDailyReportForDelivery, markDailyReportDelivered } from "@/db/repositories/reports.ts";
import { createResultView } from "@/db/repositories/result-views.ts";
import { RESULT_VIEW_TTL_DAYS } from "@/config/telegram.ts";
import { renderReportHeader } from "./render/report-header.ts";
import { renderPage } from "./render/page.ts";

export interface DeliverReportResult {
  delivered: boolean;
  alreadyDelivered: boolean;
  skippedReason?: string;
}

function hasPiece(pieces: string[], piece: string): boolean {
  return pieces.some((p) => p.startsWith(`${piece}:`));
}

export async function deliverDailyReport(ctx: TelegramCommandContext, reportDate: string): Promise<DeliverReportResult> {
  if (ctx.reportChatId === null) {
    return { delivered: false, alreadyDelivered: false, skippedReason: "TELEGRAM_REPORT_CHAT_ID not configured" };
  }

  const row = await getDailyReportForDelivery(ctx.db, reportDate, ctx.market);
  if (!row) {
    return { delivered: false, alreadyDelivered: false, skippedReason: "report not found" };
  }
  if (row.deliveredAt !== null) {
    return { delivered: false, alreadyDelivered: true };
  }

  const report = row.payload;
  const now = ctx.clock.now();
  const header = `${renderReportHeader(report)}\n\n<b>Топ дня: ${report.todayTop.length}</b>`;

  if (!hasPiece(row.telegramMessageIds, "main")) {
    const viewId = await createResultView(ctx.db, {
      kind: "today",
      headerText: header,
      extra: { reportDate, market: ctx.market, delivered: true },
      items: report.todayTop,
      createdAt: now,
      ttlDays: RESULT_VIEW_TTL_DAYS,
    });
    const page = renderPage(report.todayTop, 1, viewId, header);
    const sent = await ctx.client.sendMessage({ chat_id: ctx.reportChatId, text: page.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: page.replyMarkup });
    await appendDeliveredPiece(ctx.db, row.id, "main", sent.message_id);
  }

  if (report.stillHot.length > 0 && !hasPiece(row.telegramMessageIds, "stillhot")) {
    // Same text/button as commands/today.ts's on-demand path (production
    // hotfix Part G/incident: this automatic-delivery path previously had
    // its own separate, never-translated English copy that told the user
    // to resend /today instead of just tapping a button here directly).
    const sent = await ctx.client.sendMessage({
      chat_id: ctx.reportChatId,
      text: `♨️ Ещё ${report.stillHot.length} постов «Всё ещё в тренде» (24–72 ч) — нажмите ниже, чтобы посмотреть.`,
      reply_markup: { inline_keyboard: [[{ text: "♨️ Показать «Всё ещё в тренде»", callback_data: `sh:${reportDate}` }]] },
    });
    await appendDeliveredPiece(ctx.db, row.id, "stillhot", sent.message_id);
  }

  await markDailyReportDelivered(ctx.db, row.id, now);
  return { delivered: true, alreadyDelivered: false };
}
