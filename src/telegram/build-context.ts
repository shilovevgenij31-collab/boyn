/**
 * Wires a real TelegramCommandContext from environment + a database
 * connection — mirrors jobs/build-context.ts's role for the tick.
 * Throws if a Telegram-specific variable this needs isn't set (the
 * webhook route/dev-poll script are Telegram-specific entrypoints, brief
 * §6: "do not require Telegram env variables for build/health route/
 * normal offline tests" — but THEY do need them).
 */
import type { Database } from "@/db/client.ts";
import type { Env } from "@/config/env.ts";
import { systemClock } from "@/lib/clock.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { DEFAULT_BUDGET_PROFILE } from "@/config/budget.ts";
import { ApifyProvider } from "@/providers/apify/provider.ts";
import { BrightDataProvider } from "@/providers/brightdata/provider.ts";
import { buildRegistryConfigFromEnv, ProviderRegistry } from "@/providers/registry.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import { createTelegramClient } from "./client.ts";
import { parseAllowedUserIds, resolveAdminIds } from "./auth.ts";
import { getActiveTelegramAuthIds } from "@/db/repositories/telegram-users.ts";
import type { TelegramCommandContext } from "./context.ts";

/**
 * Async since Phase 8/9 hotfix Part L: normal/admin authorization is now
 * the union of env-configured ids (bootstrap/superadmin — never affected
 * by DB state) and `telegram_users` rows with status=ACTIVE, resolved
 * ONCE per request here and merged into the same plain Sets
 * `TelegramAuthConfig` already used — auth.ts's isAuthorized/isAdmin stay
 * pure, synchronous, and completely unchanged.
 */
export async function buildTelegramContext(db: Database, env: Env): Promise<TelegramCommandContext> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("buildTelegramContext: TELEGRAM_BOT_TOKEN is not set");
  }

  const providers: Partial<Record<RuntimeProviderId, SocialDataProvider>> = {};
  if (env.APIFY_API_TOKEN && env.APIFY_ACTOR_TIKTOK && env.APIFY_ACTOR_INSTAGRAM) {
    providers.apify = new ApifyProvider({ apiToken: env.APIFY_API_TOKEN, actorTikTok: env.APIFY_ACTOR_TIKTOK, actorInstagram: env.APIFY_ACTOR_INSTAGRAM });
  }
  if (env.BRIGHTDATA_API_TOKEN && env.BRIGHTDATA_DATASET_TIKTOK_POSTS) {
    providers.brightdata = new BrightDataProvider({ apiToken: env.BRIGHTDATA_API_TOKEN, datasetTikTokPosts: env.BRIGHTDATA_DATASET_TIKTOK_POSTS });
  }
  const registry = new ProviderRegistry(providers, buildRegistryConfigFromEnv(env));
  const circuitBreaker = new CircuitBreaker(new DbCircuitBreakerStore(db), systemClock);

  const envAllowedUserIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  const envAdminIds = resolveAdminIds(env.ADMIN_TELEGRAM_ID, env.TELEGRAM_ADMIN_USER_IDS);
  const dbActive = await getActiveTelegramAuthIds(db);
  const allowedUserIds = new Set([...envAllowedUserIds, ...dbActive.userIds]);
  const adminIds = new Set([...envAdminIds, ...dbActive.adminUserIds]);

  return {
    db,
    clock: systemClock,
    client: createTelegramClient(env.TELEGRAM_BOT_TOKEN),
    market: env.DEFAULT_MARKET ?? GLOBAL_MARKET,
    timezone: env.REPORT_TZ ?? "UTC",
    auth: { allowedUserIds, adminIds },
    reportChatId: env.TELEGRAM_REPORT_CHAT_ID ? Number(env.TELEGRAM_REPORT_CHAT_ID) : null,
    providers: registry,
    circuitBreaker,
    budgetProfile: env.BUDGET_PROFILE ?? DEFAULT_BUDGET_PROFILE,
  };
}
