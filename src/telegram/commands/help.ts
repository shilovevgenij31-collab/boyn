/**
 * `/help` (Phase 8 brief §32) — admin sees the same list plus the
 * admin-only commands appended.
 */
import type { TelegramCommandContext } from "../context.ts";

const NORMAL_COMMANDS = ["/today", "/rising", "/tiktok", "/instagram", "/cosplay", "/streamers", "/gaming", "/pc", "/playstation", "/tags", "/status", "/export", "/ideas"];
const ADMIN_COMMANDS = ["/refresh", "/track", "/untrack", "/why"];

export async function handleHelp(ctx: TelegramCommandContext, chatId: number, isAdminUser: boolean): Promise<void> {
  const lines = ["<b>Commands</b>", ...NORMAL_COMMANDS];
  if (isAdminUser) {
    lines.push("", "<b>Admin</b>", ...ADMIN_COMMANDS);
  }
  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true });
}
