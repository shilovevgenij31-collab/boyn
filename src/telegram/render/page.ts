/**
 * A single paginated Telegram message: header text + up to 5 cards, a row
 * of direct-URL buttons (one per card), and a Prev/page-indicator/Next
 * navigation row (Phase 8 brief §22). Pagination always edits the SAME
 * message in place — callers never send a new message for page N>1
 * (brief §22, §59).
 */
import type { ReportItem } from "@/core/report/types.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "../types.ts";
import { buildPaginationCallbackData } from "../callbacks.ts";
import { renderCard } from "./card.ts";

export const PAGE_SIZE = 5;
/** Hard Telegram limit is 4096 (brief §18); this is deliberate headroom
 * below it, not the limit itself. */
const SAFE_MESSAGE_LIMIT = 3800;

export interface PageRenderResult {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
  page: number;
  totalPages: number;
}

export function totalPagesFor(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / PAGE_SIZE));
}

/** `headerText` (already rendered/escaped by the caller) is repeated on
 * every page — kept short by convention so five cards always fit
 * comfortably under SAFE_MESSAGE_LIMIT; `enforceMessageLimit` is a
 * defensive last resort, not the primary size control. */
export function renderPage(items: ReportItem[], requestedPage: number, viewId: string, headerText: string): PageRenderResult {
  const totalPages = totalPagesFor(items.length);
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  const cardsText = pageItems.map((item, i) => renderCard(item, start + i + 1)).join("\n\n");
  const text = enforceMessageLimit([headerText, cardsText].filter((s) => s.length > 0).join("\n\n"));

  const urlRow: InlineKeyboardButton[] = pageItems.map((item, i) => ({ text: `▶ ${start + i + 1}`, url: item.canonicalUrl }));

  const navRow: InlineKeyboardButton[] = [];
  if (page > 1) navRow.push({ text: "◀ Prev", callback_data: buildPaginationCallbackData(viewId, page - 1) });
  navRow.push({ text: `${page}/${totalPages}`, callback_data: buildPaginationCallbackData(viewId, page) });
  if (page < totalPages) navRow.push({ text: "Next ▶", callback_data: buildPaginationCallbackData(viewId, page + 1) });

  const keyboard: InlineKeyboardButton[][] = urlRow.length > 0 ? [urlRow, navRow] : [navRow];

  return { text, replyMarkup: { inline_keyboard: keyboard }, page, totalPages };
}

/** Defensive last resort (brief §18, §73) — normal pages never get close
 * to this, but a pathological input (e.g. a caption stuffed with
 * combining characters) must never produce an over-limit message. */
export function enforceMessageLimit(text: string): string {
  if (text.length <= SAFE_MESSAGE_LIMIT) return text;
  return `${text.slice(0, SAFE_MESSAGE_LIMIT - 1)}…`;
}
