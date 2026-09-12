/**
 * Wires a real TickContext from environment + a database connection —
 * the one place production code decides which provider instances exist
 * and how the registry/circuit breaker/deadline are configured. Kept
 * separate from route.ts so it's usable from scripts (a future manual
 * trigger) without pulling in Next.js.
 */
import type { Database } from "@/db/client.ts";
import type { Env } from "@/config/env.ts";
import { systemClock } from "@/lib/clock.ts";
import { Deadline } from "@/lib/deadline.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { DEFAULT_BUDGET_PROFILE } from "@/config/budget.ts";
import { DEFAULT_TICK_DEADLINE_MS } from "@/config/schedule.ts";
import { ApifyProvider } from "@/providers/apify/provider.ts";
import { BrightDataProvider } from "@/providers/brightdata/provider.ts";
import { buildRegistryConfigFromEnv, ProviderRegistry } from "@/providers/registry.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import type { TickContext } from "./types.ts";

export function buildTickContext(db: Database, env: Env): TickContext {
  const providers: Partial<Record<RuntimeProviderId, SocialDataProvider>> = {};

  if (env.APIFY_API_TOKEN && env.APIFY_ACTOR_TIKTOK && env.APIFY_ACTOR_INSTAGRAM) {
    providers.apify = new ApifyProvider({
      apiToken: env.APIFY_API_TOKEN,
      actorTikTok: env.APIFY_ACTOR_TIKTOK,
      actorInstagram: env.APIFY_ACTOR_INSTAGRAM,
    });
  }
  if (env.BRIGHTDATA_API_TOKEN && env.BRIGHTDATA_DATASET_TIKTOK_POSTS) {
    providers.brightdata = new BrightDataProvider({
      apiToken: env.BRIGHTDATA_API_TOKEN,
      datasetTikTokPosts: env.BRIGHTDATA_DATASET_TIKTOK_POSTS,
    });
  }

  const registry = new ProviderRegistry(providers, buildRegistryConfigFromEnv(env));
  const circuitBreaker = new CircuitBreaker(new DbCircuitBreakerStore(db), systemClock);
  const deadlineMs = env.TICK_DEADLINE_MS ? Number(env.TICK_DEADLINE_MS) : DEFAULT_TICK_DEADLINE_MS;

  return {
    db,
    providers: registry,
    circuitBreaker,
    clock: systemClock,
    deadline: new Deadline(deadlineMs, systemClock),
    market: GLOBAL_MARKET,
    budgetProfile: env.BUDGET_PROFILE ?? DEFAULT_BUDGET_PROFILE,
  };
}
