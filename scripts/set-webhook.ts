/**
 * Registers the production webhook (Phase 8 brief §63). Never prints the
 * bot token — only the resulting webhook URL, which doesn't contain it.
 *
 * Usage: npx tsx scripts/set-webhook.ts --base-url=https://your-app.vercel.app
 * (or set APP_BASE_URL in .env.local and omit --base-url)
 */
import "./load-env.ts";
import { getEnv } from "@/config/env.ts";
import { createTelegramClient } from "@/telegram/client.ts";

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--base-url="));
  const env = getEnv();
  const baseUrl = arg ? arg.slice("--base-url=".length) : env.APP_BASE_URL;

  if (!baseUrl) {
    console.error("[set-webhook] provide --base-url=https://... or set APP_BASE_URL in .env.local");
    process.exitCode = 1;
    return;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    console.error("[set-webhook] TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set");
    process.exitCode = 1;
    return;
  }

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const url = `${baseUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
  await client.setWebhook({ url, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
  console.log(`[set-webhook] webhook set to ${url}`);
}

main().catch((error) => {
  console.error("[set-webhook] FATAL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
