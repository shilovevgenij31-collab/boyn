/**
 * `/start` (Phase 8 brief §31). Authorized/unauthorized text lives here
 * only — router.ts already decided which branch to call.
 */
import type { TelegramCommandContext } from "../context.ts";

export const PRIVATE_BOT_MESSAGE = "This is a private bot. If you believe you should have access, contact the operator.";

export async function handleStart(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const text = [
    "👋 <b>Trend Radar</b>",
    "Tracks fresh and rising TikTok + Instagram content across a monitored set of themes (cosplay, streaming, gaming, PC, PlayStation, and hashtags discovered along the way).",
    "Every ranked post links directly to the original TikTok/Instagram post — never a provider or CDN URL.",
    "",
    "Send /help for the full command list.",
  ].join("\n");
  await ctx.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

