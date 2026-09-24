/**
 * Central update dispatch (Phase 8 brief §5, §57-59): the one place that
 * decides what an incoming Telegram Update means. Deterministic and
 * directly callable — the webhook route (which now awaits this fully
 * before responding — see route.ts's module comment for why) and
 * scripts/dev-poll.ts both feed updates through this same function, and
 * tests call it directly with a recording client (brief §76). All
 * user-facing text is Russian (Phase 8/9 production hotfix §6).
 */
import type { TelegramCommandContext } from "./context.ts";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types.ts";
import { isAdmin, isAuthorized } from "./auth.ts";
import { parsePaginationCallbackData } from "./callbacks.ts";
import { ADMIN_CALLBACK_DENIED_MESSAGE, handleAccessDecisionCallback, handleAccessRequest } from "./access-request.ts";
import { getResultView } from "@/db/repositories/result-views.ts";
import { getDailyReport } from "@/db/repositories/reports.ts";
import { createResultView } from "@/db/repositories/result-views.ts";
import { RESULT_VIEW_TTL_DAYS } from "@/config/telegram.ts";
import { renderPage } from "./render/page.ts";
import { renderStillHotHeader } from "./render/report-header.ts";
import { recordErrorEvent } from "@/db/repositories/error-events.ts";

import { handleStart, PRIVATE_BOT_MESSAGE } from "./commands/start.ts";
import { handleHelp } from "./commands/help.ts";
import { handleToday } from "./commands/today.ts";
import { handleRising } from "./commands/rising.ts";
import { handleCategoryFilter, handlePlatformFilter } from "./commands/filter.ts";
import { handleTags } from "./commands/tags.ts";
import { handleStatus } from "./commands/status.ts";
import { handleExport } from "./commands/export.ts";
import { handleIdeas } from "./commands/ideas.ts";
import { handleRefresh } from "./commands/refresh.ts";
import { handleTrack } from "./commands/track.ts";
import { handleUntrack } from "./commands/untrack.ts";
import { handleWhy } from "./commands/why.ts";

type CommandHandler = (ctx: TelegramCommandContext, message: TelegramMessage, args: string, userId: number) => Promise<void>;

interface CommandDefinition {
  adminOnly: boolean;
  handler: CommandHandler;
}

const COMMANDS: Record<string, CommandDefinition> = {
  "/start": { adminOnly: false, handler: (ctx, m) => handleStart(ctx, m.chat.id) },
  "/help": { adminOnly: false, handler: (ctx, m, _args, userId) => handleHelp(ctx, m.chat.id, isAdmin(userId, ctx.auth)) },
  "/today": { adminOnly: false, handler: (ctx, m) => handleToday(ctx, m.chat.id) },
  "/rising": { adminOnly: false, handler: (ctx, m) => handleRising(ctx, m.chat.id) },
  "/tiktok": { adminOnly: false, handler: (ctx, m) => handlePlatformFilter(ctx, m.chat.id, "tiktok") },
  "/instagram": { adminOnly: false, handler: (ctx, m) => handlePlatformFilter(ctx, m.chat.id, "instagram") },
  "/cosplay": { adminOnly: false, handler: (ctx, m) => handleCategoryFilter(ctx, m.chat.id, "cosplay") },
  "/streamers": { adminOnly: false, handler: (ctx, m) => handleCategoryFilter(ctx, m.chat.id, "streaming") },
  "/gaming": { adminOnly: false, handler: (ctx, m) => handleCategoryFilter(ctx, m.chat.id, "gaming") },
  "/pc": { adminOnly: false, handler: (ctx, m) => handleCategoryFilter(ctx, m.chat.id, "pc") },
  "/playstation": { adminOnly: false, handler: (ctx, m) => handleCategoryFilter(ctx, m.chat.id, "playstation") },
  "/tags": { adminOnly: false, handler: (ctx, m) => handleTags(ctx, m.chat.id) },
  "/status": { adminOnly: false, handler: (ctx, m, _args, userId) => handleStatus(ctx, m.chat.id, isAdmin(userId, ctx.auth)) },
  "/export": { adminOnly: false, handler: (ctx, m, args) => handleExport(ctx, m.chat.id, args) },
  "/ideas": { adminOnly: false, handler: (ctx, m) => handleIdeas(ctx, m.chat.id) },
  "/refresh": { adminOnly: true, handler: (ctx, m, args) => handleRefresh(ctx, m.chat.id, args) },
  "/track": { adminOnly: true, handler: (ctx, m, args) => handleTrack(ctx, m.chat.id, args) },
  "/untrack": { adminOnly: true, handler: (ctx, m, args) => handleUntrack(ctx, m.chat.id, args) },
  "/why": { adminOnly: true, handler: (ctx, m, args) => handleWhy(ctx, m.chat.id, args) },
};

/** Production hotfix (brief §5): split on ANY whitespace (space, tab,
 * newline), not just a literal space — a command followed directly by a
 * newline (e.g. pasted multi-line text) previously failed to match any
 * entry in COMMANDS at all, since `indexOf(" ")` never found a boundary
 * and the whole "/today\nfoo" string was treated as one unmatched
 * "command" token. */
function parseCommandLine(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const rawCommand = match[1]!;
  const args = match[2]!.trim();
  const command = rawCommand.split("@")[0]!.toLowerCase();
  if (command.length <= 1) return null;
  return { command, args };
}

async function safeRecordError(ctx: TelegramCommandContext, scope: string, error: unknown): Promise<void> {
  try {
    await recordErrorEvent(ctx.db, { at: ctx.clock.now(), scope, severity: "ERROR", message: error instanceof Error ? error.message : String(error) });
  } catch {
    // Logging must never itself crash the router.
  }
}

export async function handleMessage(ctx: TelegramCommandContext, message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  const chatId = message.chat.id;
  if (userId === undefined) return; // no identifiable sender — nothing safe to do

  if (!isAuthorized(userId, ctx.auth)) {
    // Production hotfix (Part H-J): an unknown user's /start starts a
    // durable access request instead of a dead-end "private bot" reply.
    // Any OTHER command from an unauthorized sender keeps the original
    // no-data-leak denial — this never creates a request row from
    // arbitrary unauthorized traffic, only a deliberate /start.
    const parsed = message.text ? parseCommandLine(message.text) : null;
    if (parsed?.command === "/start" && message.from) {
      try {
        await handleAccessRequest(ctx, chatId, message.from);
      } catch (error) {
        await safeRecordError(ctx, "telegram.access-request", error);
      }
      return;
    }
    try {
      await ctx.client.sendMessage({ chat_id: chatId, text: PRIVATE_BOT_MESSAGE, disable_web_page_preview: true });
    } catch {
      /* best effort — never throw out of the router for an unauthorized sender */
    }
    return;
  }

  const text = message.text;
  if (!text) return; // non-text message: nothing to route

  const parsed = parseCommandLine(text);
  if (!parsed) return; // not a command: ignore safely

  const def = COMMANDS[parsed.command];
  if (!def) return; // unknown command: ignore safely (brief §10's spirit applied to commands too)

  if (def.adminOnly && !isAdmin(userId, ctx.auth)) {
    await ctx.client.sendMessage({ chat_id: chatId, text: "Эта команда доступна только администратору." });
    return;
  }

  try {
    await def.handler(ctx, message, parsed.args, userId);
  } catch (error) {
    await safeRecordError(ctx, `telegram.command${parsed.command}`, error);
    try {
      await ctx.client.sendMessage({ chat_id: chatId, text: "Не удалось выполнить команду. Ошибка записана; попробуйте ещё раз через минуту." });
    } catch {
      /* best effort */
    }
  }
}

async function handleStillHotCallback(ctx: TelegramCommandContext, cq: TelegramCallbackQuery, reportDate: string): Promise<void> {
  const chatId = cq.message!.chat.id;
  const report = await getDailyReport(ctx.db, reportDate, ctx.market);
  if (!report || report.stillHot.length === 0) {
    await ctx.client.sendMessage({ chat_id: chatId, text: "Раздел «Всё ещё в тренде» для этого отчёта больше недоступен." });
    return;
  }
  const header = renderStillHotHeader(report);
  const now = ctx.clock.now();
  const viewId = await createResultView(ctx.db, { kind: "stillhot", headerText: header, extra: { reportDate }, items: report.stillHot, createdAt: now, ttlDays: RESULT_VIEW_TTL_DAYS });
  const page = renderPage(report.stillHot, 1, viewId, header);
  await ctx.client.sendMessage({ chat_id: chatId, text: page.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: page.replyMarkup });
}

export async function handleCallback(ctx: TelegramCommandContext, cq: TelegramCallbackQuery): Promise<void> {
  const userId = cq.from.id;

  if (!isAuthorized(userId, ctx.auth)) {
    try {
      await ctx.client.answerCallbackQuery({ callback_query_id: cq.id, text: "Нет доступа.", show_alert: true });
    } catch {
      /* best effort */
    }
    return;
  }

  if (!cq.data) {
    try {
      await ctx.client.answerCallbackQuery({ callback_query_id: cq.id });
    } catch {
      /* best effort */
    }
    return;
  }

  // Access-decision callbacks (Part K) never need cq.message (they act on
  // a target userId encoded in cq.data, not "the message this button is
  // attached to") and are gated by isAdmin, not just isAuthorized above —
  // a normal authorized user must never be able to approve/deny anyone.
  if (cq.data.startsWith("access:")) {
    if (!isAdmin(userId, ctx.auth)) {
      try {
        await ctx.client.answerCallbackQuery({ callback_query_id: cq.id, text: ADMIN_CALLBACK_DENIED_MESSAGE, show_alert: true });
      } catch {
        /* best effort */
      }
      return;
    }
    try {
      await ctx.client.answerCallbackQuery({ callback_query_id: cq.id });
    } catch {
      /* best effort */
    }
    try {
      await handleAccessDecisionCallback(ctx, cq);
    } catch (error) {
      await safeRecordError(ctx, "telegram.callback.access", error);
    }
    return;
  }

  if (!cq.message) {
    try {
      await ctx.client.answerCallbackQuery({ callback_query_id: cq.id });
    } catch {
      /* best effort */
    }
    return;
  }

  // Ack promptly (brief §58) before doing any slower work.
  try {
    await ctx.client.answerCallbackQuery({ callback_query_id: cq.id });
  } catch {
    /* an ack failure must not block the rest of the handling */
  }

  if (cq.data.startsWith("sh:")) {
    const reportDate = cq.data.slice("sh:".length);
    try {
      await handleStillHotCallback(ctx, cq, reportDate);
    } catch (error) {
      await safeRecordError(ctx, "telegram.callback.stillhot", error);
    }
    return;
  }

  const parsed = parsePaginationCallbackData(cq.data);
  if (!parsed) return; // malformed callback — never crash (brief §57)

  try {
    const view = await getResultView(ctx.db, parsed.viewId, ctx.clock.now());
    if (!view) {
      await ctx.client.sendMessage({ chat_id: cq.message.chat.id, text: "Список устарел. Запустите команду ещё раз." });
      return;
    }
    const page = renderPage(view.items, parsed.page, parsed.viewId, view.headerText);
    await ctx.client.editMessageText({ chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: page.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: page.replyMarkup });
  } catch (error) {
    await safeRecordError(ctx, "telegram.callback.pagination", error);
  }
}

export async function routeUpdate(ctx: TelegramCommandContext, update: TelegramUpdate): Promise<void> {
  if (update.message) {
    await handleMessage(ctx, update.message);
    return;
  }
  if (update.callback_query) {
    await handleCallback(ctx, update.callback_query);
    return;
  }
  // Unknown/unhandled update type: acknowledge and ignore safely (brief §10).
}
