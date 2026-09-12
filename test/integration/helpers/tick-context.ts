import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import { DEFAULT_REGISTRY_CONFIG, ProviderRegistry, type RegistryConfig } from "@/providers/registry.ts";
import type { FixtureProvider } from "@/providers/fixture/provider.ts";
import { Deadline } from "@/lib/deadline.ts";
import type { FixedClock } from "@/lib/clock.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import type { BudgetProfileName } from "@/config/budget.ts";
import type { TickContext } from "@/jobs/types.ts";
import type { TestDatabase } from "./test-db.ts";

/** Wraps a FixtureProvider (id: "fixture") so it can be registered under a
 * real, persistable ProviderId — the same trick Phase 4's registry tests
 * use, since provider_jobs.provider can never be "fixture". */
export function wrapFixtureAsProvider(id: "apify" | "brightdata", fixture: FixtureProvider): SocialDataProvider {
  return {
    id,
    capabilities: () => fixture.capabilities(),
    submitDiscovery: (input) => fixture.submitDiscovery(input),
    submitRefresh: (input) => fixture.submitRefresh(input),
    getStatus: (externalJobId) => fixture.getStatus(externalJobId),
    fetchResults: (externalJobId) => fixture.fetchResults(externalJobId),
    cancel: (externalJobId) => fixture.cancel(externalJobId),
  };
}

export interface BuildTestTickContextParams {
  db: TestDatabase;
  clock: FixedClock;
  apify?: FixtureProvider;
  brightdata?: FixtureProvider;
  deadlineMs?: number;
  registryConfig?: RegistryConfig;
  budgetProfile?: BudgetProfileName;
}

export function buildTestTickContext(params: BuildTestTickContextParams): TickContext {
  const providers: Partial<Record<RuntimeProviderId, SocialDataProvider>> = {};
  if (params.apify) providers.apify = wrapFixtureAsProvider("apify", params.apify);
  if (params.brightdata) providers.brightdata = wrapFixtureAsProvider("brightdata", params.brightdata);

  return {
    db: params.db,
    providers: new ProviderRegistry(providers, params.registryConfig ?? DEFAULT_REGISTRY_CONFIG),
    circuitBreaker: new CircuitBreaker(new DbCircuitBreakerStore(params.db), params.clock),
    clock: params.clock,
    // A large default so tests that advance the FixedClock across several
    // simulated ticks (while reusing one TickContext/Deadline instance)
    // don't spuriously trip the deadline — production always constructs a
    // fresh Deadline per tick (see jobs/build-context.ts). Tests that
    // specifically exercise deadline behavior build their own Deadline.
    deadline: new Deadline(params.deadlineMs ?? 24 * 60 * 60_000, params.clock),
    market: GLOBAL_MARKET,
    budgetProfile: params.budgetProfile ?? "STANDARD",
  };
}
