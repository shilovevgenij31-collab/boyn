/**
 * In-bot access-request/approval flow (Phase 8/9 hotfix Parts H-L,
 * production incident: env-only multi-admin required the owner to
 * manually discover a numeric Telegram id via a third-party bot before
 * granting anyone access — this never actually completed for the
 * intended second admin). An unknown user's `/start` creates a durable
 * PENDING request (telegram_users) instead of just saying "private bot";
 * every current admin gets a notification with inline approve/deny
 * buttons carrying the target's real numeric user_id — never a username.
 */
import type { TelegramCommandContext } from "./context.ts";
import type { TelegramCallbackQuery, TelegramUser } from "./types.ts";
import { isAdmin } from "./auth.ts";
import { buildAccessCallbackData, parseAccessCallbackData } from "./callbacks.ts";
import { approveTelegramUser, denyTelegramUser, upsertAccessRequest, type TelegramUserRow } from "@/db/repositories/telegram-users.ts";

const PENDING_MESSAGE = "Запрос на доступ отправлен администратору.";
const DENIED_MESSAGE = "Доступ отклонён администратором.";
export const ADMIN_CALLBACK_DENIED_MESSAGE = "Эта кнопка доступна только администратору.";

/** Plain text (no parse_mode) — a Telegram username can only ever be
 * A-Z a-z 0-9 _ (Telegram's own username rules), so there's nothing here
 * that needs HTML-escaping the way rendered post captions do. */
function describeRequester(row: TelegramUserRow): string {
  const lines = ["Новый запрос на доступ:"];
  lines.push(row.username ? `@${row.username}` : "(без username)");
  lines.push(`Telegram ID: ${row.userId}`);
  return lines.join("\n");
}

async function notifyAdminsOfAccessRequest(ctx: TelegramCommandContext, row: TelegramUserRow): Promise<void> {
  const text = describeRequester(row);
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Разрешить", callback_data: buildAccessCallbackData("allow", row.userId) },
        { text: "🛡 Сделать админом", callback_data: buildAccessCallbackData("admin", row.userId) },
        { text: "❌ Отклонить", callback_data: buildAccessCallbackData("deny", row.userId) },
      ],
    ],
  };
  for (const adminId of ctx.auth.adminIds) {
    try {
      await ctx.client.sendMessage({ chat_id: adminId, text, reply_markup: replyMarkup });
    } catch {
      // Best effort per admin — one admin blocking the bot must never
      // stop the others from being notified.
    }
  }
}

/** Called from router.ts's handleMessage ONLY for an unauthorized
 * sender's `/start` — any other command from an unauthorized user still
 * gets the plain private-bot denial (brief §7's "never a data leak
 * path", unchanged), so this never creates a request row from arbitrary
 * unauthorized traffic. */
export async function handleAccessRequest(ctx: TelegramCommandContext, chatId: number, from: TelegramUser): Promise<void> {
  const now = ctx.clock.now();
  const { isNewRequest, row } = await upsertAccessRequest(ctx.db, {
    userId: from.id,
    chatId,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    now,
  });

  if (row.status === "DENIED") {
    try {
      await ctx.client.sendMessage({ chat_id: chatId, text: DENIED_MESSAGE });
    } catch {
      /* best effort */
    }
    return;
  }

  try {
    await ctx.client.sendMessage({ chat_id: chatId, text: PENDING_MESSAGE });
  } catch {
    /* best effort */
  }

  if (isNewRequest) {
    await notifyAdminsOfAccessRequest(ctx, row);
  }
}

/** Router.ts already verified `isAdmin(cq.from.id, ctx.auth)` before
 * calling this — kept as a defensive re-check here too since this
 * function's own idempotency guarantee (no duplicate notify) depends on
 * only ever being reached through that gate. */
export async function handleAccessDecisionCallback(ctx: TelegramCommandContext, cq: TelegramCallbackQuery): Promise<void> {
  if (!isAdmin(cq.from.id, ctx.auth) || !cq.data) return;
  const parsed = parseAccessCallbackData(cq.data);
  if (!parsed) return; // malformed callback — never crash (brief §57)

  const now = ctx.clock.now();
  const approvedBy = cq.from.id;

  if (parsed.action === "deny") {
    const result = await denyTelegramUser(ctx.db, { userId: parsed.userId, approvedBy, now });
    if (result.changed && result.row) {
      try {
        await ctx.client.sendMessage({ chat_id: result.row.userId, text: "Доступ к Trend Radar отклонён." });
      } catch {
        /* best effort — the requester may have blocked the bot */
      }
    }
    return;
  }

  const role = parsed.action === "admin" ? "ADMIN" : "USER";
  const result = await approveTelegramUser(ctx.db, { userId: parsed.userId, role, approvedBy, now });
  if (result.changed && result.row) {
    const text = role === "ADMIN" ? "Вам выданы права администратора Trend Radar." : "Доступ к Trend Radar открыт.";
    try {
      await ctx.client.sendMessage({ chat_id: result.row.userId, text });
    } catch {
      /* best effort */
    }
  }
}
