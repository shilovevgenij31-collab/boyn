/**
 * Registers the public command list (Phase 8 brief §64; Russian
 * localization — Phase 8/9 hotfix §18: descriptions are Russian, command
 * identifiers stay English/Latin). Admin commands (`/refresh`, `/track`,
 * `/untrack`, `/why`) are deliberately excluded — they stay reachable via
 * `/help` for the admin only, never advertised in Telegram's command menu.
 */
import "./load-env.ts";
import { getEnv } from "@/config/env.ts";
import { createTelegramClient } from "@/telegram/client.ts";
import type { BotCommand } from "@/telegram/types.ts";

const NORMAL_COMMANDS: BotCommand[] = [
  { command: "start", description: "О Trend Radar" },
  { command: "help", description: "Список команд" },
  { command: "today", description: "Тренды за сегодня" },
  { command: "rising", description: "Что растёт прямо сейчас" },
  { command: "tiktok", description: "TikTok, свежее и в рейтинге" },
  { command: "instagram", description: "Instagram, свежее и в рейтинге" },
  { command: "cosplay", description: "Тренды по cosplay" },
  { command: "streamers", description: "Стримеры" },
  { command: "gaming", description: "Гейминг" },
  { command: "pc", description: "PC-гейминг" },
  { command: "playstation", description: "PlayStation" },
  { command: "tags", description: "Динамика хэштегов" },
  { command: "status", description: "Состояние системы" },
  { command: "export", description: "Выгрузить последний отчёт" },
  { command: "ideas", description: "Краткий анализ паттернов" },
];

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("[set-commands] TELEGRAM_BOT_TOKEN must be set");
    process.exitCode = 1;
    return;
  }
  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  await client.setMyCommands(NORMAL_COMMANDS);
  console.log(`[set-commands] registered ${NORMAL_COMMANDS.length} public commands`);
}

main().catch((error) => {
  console.error("[set-commands] FATAL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
