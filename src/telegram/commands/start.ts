/**
 * `/start` (Phase 8 brief §31; Russian localization — Phase 8/9 hotfix
 * §9). Authorized/unauthorized text lives here only — router.ts already
 * decided which branch to call.
 */
import type { TelegramCommandContext } from "../context.ts";

export const PRIVATE_BOT_MESSAGE = "Это приватный бот. Если считаете, что у вас должен быть доступ, обратитесь к администратору.";

export async function handleStart(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const text = [
    "👋 <b>Trend Radar</b>",
    "Отслеживаю свежие и быстро растущие ролики TikTok и Instagram по выбранным темам (cosplay, стриминг, гейминг, PC, PlayStation и хэштеги, найденные по пути).",
    "Я анализирую метаданные, скорость роста просмотров, вовлечённость и динамику хэштегов — бот не смотрит сами видео. Каждый пост в отчёте ведёт напрямую на оригинал в TikTok/Instagram, никогда не на ссылку провайдера или CDN.",
    "",
    "Основные команды:",
    "/today — итоги за сегодня",
    "/rising — что растёт прямо сейчас",
    "/status — состояние системы",
    "/help — все команды",
  ].join("\n");
  await ctx.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}
