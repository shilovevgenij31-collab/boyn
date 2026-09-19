/**
 * `/help` (Phase 8 brief §32; Russian localization — Phase 8/9 hotfix
 * §10) — admin sees the same list plus the admin-only commands appended.
 * Command identifiers stay in English (Latin script); descriptions are
 * Russian.
 */
import type { TelegramCommandContext } from "../context.ts";

const NORMAL_COMMANDS: [string, string][] = [
  ["/today", "тренды за последние 24 часа"],
  ["/rising", "ролики, которые быстро растут прямо сейчас"],
  ["/tiktok", "актуальные TikTok-тренды"],
  ["/instagram", "актуальные Instagram-тренды"],
  ["/cosplay", "тренды по cosplay"],
  ["/streamers", "стримеры"],
  ["/gaming", "гейминг"],
  ["/pc", "PC-гейминг"],
  ["/playstation", "PlayStation"],
  ["/tags", "динамика хэштегов в нашей выборке"],
  ["/status", "состояние системы"],
  ["/export", "выгрузить отчёт (.md/.csv/.json)"],
  ["/ideas", "краткий анализ паттернов (без AI)"],
];

const ADMIN_COMMANDS: [string, string][] = [
  ["/refresh", "запустить внеплановый сбор"],
  ["/track", "добавить хэштег в отслеживание"],
  ["/untrack", "убрать хэштег из активного отслеживания"],
  ["/why", "почему пост получил такой score"],
];

function formatList(commands: [string, string][]): string[] {
  return commands.map(([cmd, desc]) => `${cmd} — ${desc}`);
}

export async function handleHelp(ctx: TelegramCommandContext, chatId: number, isAdminUser: boolean): Promise<void> {
  const lines = ["<b>Команды</b>", ...formatList(NORMAL_COMMANDS)];
  if (isAdminUser) {
    lines.push("", "<b>Для администратора</b>", ...formatList(ADMIN_COMMANDS));
  }
  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true });
}
