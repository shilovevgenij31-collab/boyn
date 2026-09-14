import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import type { Market } from "@/core/domain/market.ts";
import type { ProviderRegistry } from "@/providers/registry.ts";
import type { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import type { BudgetProfileName } from "@/config/budget.ts";
import type { TelegramClient } from "./client.ts";
import type { TelegramAuthConfig } from "./auth.ts";

/** Everything a command handler needs — bundled once by the route/script
 * entry point (brief §5's expected structure), never constructed inline
 * inside a handler. `providers`/`circuitBreaker`/`budgetProfile` exist
 * only for `/refresh` (brief §50-51: reuse the exact same durable
 * planning primitives jobs/plan-discovery.ts uses — never call a
 * provider directly from a Telegram handler). */
export interface TelegramCommandContext {
  db: Database;
  clock: Clock;
  client: TelegramClient;
  market: Market;
  timezone: string;
  auth: TelegramAuthConfig;
  /** Target chat for automatic DailyReport delivery (brief §65) — `null`
   * when `TELEGRAM_REPORT_CHAT_ID` isn't configured yet; delivery is
   * simply skipped in that case, never sent to a guessed chat. */
  reportChatId: number | null;
  providers: ProviderRegistry;
  circuitBreaker: CircuitBreaker;
  budgetProfile: BudgetProfileName;
}
