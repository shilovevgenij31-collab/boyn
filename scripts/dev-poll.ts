/**
 * Local development long-polling (Phase 8 brief §61-62) — feeds every
 * update into the SAME router the webhook route uses. Local dev only;
 * never imported into the Vercel route runtime.
 *
 * Telegram refuses `getUpdates` while a webhook is registered. Pass
 * `--delete-webhook` to explicitly clear it first — this script never
 * deletes a webhook silently (brief §62).
 *
 * Usage: npx tsx scripts/dev-poll.ts [--delete-webhook]
 */
import "./load-env.ts";
import { getDb, closeDb } from "@/db/client.ts";
import { getEnv } from "@/config/env.ts";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { tryClaimUpdate } from "@/db/repositories/telegram-updates.ts";
import { isTelegramError } from "@/telegram/errors.ts";

async function main(): Promise<void> {
  const deleteWebhookFlag = process.argv.slice(2).includes("--delete-webhook");
  const env = getEnv();
  const db = getDb();
  const ctx = await buildTelegramContext(db, env);

  const me = await ctx.client.getMe();
  console.log(`[dev-poll] polling as @${me.username}`);

  if (deleteWebhookFlag) {
    await ctx.client.deleteWebhook();
    console.log("[dev-poll] webhook deleted (--delete-webhook)");
  }

  let offset: number | undefined;
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\n[dev-poll] shutting down...");
  });

  while (running) {
    let updates;
    try {
      updates = await ctx.client.getUpdates({ offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    } catch (error) {
      if (isTelegramError(error) && error.httpStatus === 409) {
        console.error("[dev-poll] Telegram rejected getUpdates — a webhook is likely still active. Rerun with --delete-webhook.");
        process.exitCode = 1;
        break;
      }
      console.error("[dev-poll] getUpdates failed:", error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const claimed = await tryClaimUpdate(db, update.update_id, new Date());
      if (!claimed) continue;
      try {
        await routeUpdate(ctx, update);
      } catch (error) {
        console.error("[dev-poll] update handling failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error("[dev-poll] FATAL:", error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
