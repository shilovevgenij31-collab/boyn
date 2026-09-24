/**
 * Wires real `runDaily` params from environment + a database connection —
 * mirrors build-context.ts's role for the tick, kept separate so it's
 * usable from a script without pulling in Next.js.
 */
import type { Database } from "@/db/client.ts";
import type { Env } from "@/config/env.ts";
import { systemClock } from "@/lib/clock.ts";
import { Deadline } from "@/lib/deadline.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { DEFAULT_BUDGET_PROFILE } from "@/config/budget.ts";
import { DEFAULT_DAILY_DEADLINE_MS } from "@/config/schedule.ts";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import type { RunDailyParams } from "./run-daily.ts";

export async function buildDailyContext(db: Database, env: Env): Promise<RunDailyParams> {
  // Telegram delivery is best-effort (brief §24-27): if it isn't
  // configured at all (no TELEGRAM_BOT_TOKEN), `buildTelegramContext`
  // throws by design (it's meant for entry points that require it) — here
  // that just means the daily job skips delivery entirely rather than
  // failing the whole pipeline.
  let telegramContext;
  try {
    telegramContext = await buildTelegramContext(db, env);
  } catch {
    telegramContext = undefined;
  }

  return {
    db,
    clock: systemClock,
    market: env.DEFAULT_MARKET ?? GLOBAL_MARKET,
    timezone: env.REPORT_TZ ?? "UTC",
    budgetProfile: env.BUDGET_PROFILE ?? DEFAULT_BUDGET_PROFILE,
    deadline: new Deadline(DEFAULT_DAILY_DEADLINE_MS, systemClock),
    telegramContext,
  };
}
