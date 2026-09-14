/**
 * Shared helpers every paginated command uses (Phase 8 brief §20-22) —
 * one place that turns a frozen item list into the first page's message,
 * so `/today`, `/rising`, platform/category filters, and the pagination
 * callback handler in router.ts all render identically.
 */
import type { TelegramCommandContext } from "../context.ts";
import type { ReportItem } from "@/core/report/types.ts";
import { renderPage } from "../render/page.ts";

export async function sendPaginatedView(ctx: TelegramCommandContext, chatId: number, viewId: string, items: ReportItem[], headerText: string): Promise<void> {
  if (items.length === 0) {
    await ctx.client.sendMessage({ chat_id: chatId, text: `${headerText}\n\n(no qualifying posts right now)`, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }
  const page = renderPage(items, 1, viewId, headerText);
  await ctx.client.sendMessage({ chat_id: chatId, text: page.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: page.replyMarkup });
}

export function requireUserId(message: { from?: { id: number } }): number | null {
  return message.from?.id ?? null;
}
