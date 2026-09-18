/**
 * Registers the public command list (Phase 8 brief §64). Admin commands
 * (`/refresh`, `/track`, `/untrack`, `/why`) are deliberately excluded —
 * they stay reachable via `/help` for the admin only, never advertised in
 * Telegram's command menu.
 */
import "./load-env.ts";
import { getEnv } from "@/config/env.ts";
import { createTelegramClient } from "@/telegram/client.ts";
import type { BotCommand } from "@/telegram/types.ts";

const NORMAL_COMMANDS: BotCommand[] = [
  { command: "start", description: "About Trend Radar" },
  { command: "help", description: "List commands" },
  { command: "today", description: "Today's ranked report" },
  { command: "rising", description: "Currently rising posts" },
  { command: "tiktok", description: "TikTok, recent & ranked" },
  { command: "instagram", description: "Instagram, recent & ranked" },
  { command: "cosplay", description: "Cosplay, recent & ranked" },
  { command: "streamers", description: "Streaming, recent & ranked" },
  { command: "gaming", description: "Gaming, recent & ranked" },
  { command: "pc", description: "PC gaming, recent & ranked" },
  { command: "playstation", description: "PlayStation, recent & ranked" },
  { command: "tags", description: "Tracked hashtag radar" },
  { command: "status", description: "System status" },
  { command: "export", description: "Export the latest report" },
  { command: "ideas", description: "Deterministic theme summary" },
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
