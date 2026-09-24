import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryCircuitBreakerStore } from "@/providers/circuit-breaker.ts";
import { InMemoryProviderQuotaStore, ProviderQuotaTracker } from "@/providers/quota-tracker.ts";
import { ProviderError } from "@/providers/errors.ts";
import { DEFAULT_REGISTRY_CONFIG, ProviderRegistry } from "@/providers/registry.ts";
import { FixtureProvider } from "@/providers/fixture/provider.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import { FixedClock } from "@/lib/clock.ts";

function makeProvider(id: RuntimeProviderId, overrides: Partial<ReturnType<SocialDataProvider["capabilities"]>> = {}): SocialDataProvider {
  const fixture = new FixtureProvider({ jobs: [] });
  return {
    id,
    capabilities: () => ({
      tiktok: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
      instagram: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
      ...overrides,
    }),
    submitDiscovery: fixture.submitDiscovery.bind(fixture),
    submitRefresh: fixture.submitRefresh.bind(fixture),
    getStatus: fixture.getStatus.bind(fixture),
    fetchResults: fixture.fetchResults.bind(fixture),
  };
}

describe("ProviderRegistry.resolve", () => {
  it("routes TikTok discovery to Apify primary / Bright Data fallback", () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);

    const route = registry.resolve("tiktok", "DISCOVERY");
    expect(route.primary.id).toBe("apify");
    expect(route.fallback?.id).toBe("brightdata");
  });

  it("routes TikTok refresh to Apify only, no fallback", () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);

    const route = registry.resolve("tiktok", "REFRESH");
    expect(route.primary.id).toBe("apify");
    expect(route.fallback).toBeNull();
  });

  it("routes Instagram discovery to Apify with no fallback (none exists for MVP)", () => {
    const apify = makeProvider("apify");
    const registry = new ProviderRegistry({ apify }, DEFAULT_REGISTRY_CONFIG);

    const route = registry.resolve("instagram", "DISCOVERY");
    expect(route.primary.id).toBe("apify");
    expect(route.fallback).toBeNull();
  });

  it("Instagram refresh is UNSUPPORTED — no provider is even looked up", () => {
    const apify = makeProvider("apify");
    const registry = new ProviderRegistry({ apify }, DEFAULT_REGISTRY_CONFIG);

    expect(() => registry.resolve("instagram", "REFRESH")).toThrow(ProviderError);
    try {
      registry.resolve("instagram", "REFRESH");
    } catch (err) {
      expect((err as ProviderError).code).toBe("UNSUPPORTED");
    }
  });

  it("a misconfigured env override pointing at an unregistered provider instance fails clearly, not silently", () => {
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry(
      { brightdata },
      { ...DEFAULT_REGISTRY_CONFIG, tiktokDiscoveryPrimary: "apify" },
    );
    expect(() => registry.resolve("tiktok", "DISCOVERY")).toThrow(ProviderError);
  });

  it("a misconfigured env override pointing discovery at a provider that doesn't support it fails clearly", () => {
    const apify = makeProvider("apify", { tiktok: { discovery: false, refreshByUrl: true, multiQueryAttribution: true } });
    const registry = new ProviderRegistry({ apify }, { ...DEFAULT_REGISTRY_CONFIG, tiktokDiscoveryFallback: null });
    expect(() => registry.resolve("tiktok", "DISCOVERY")).toThrow(ProviderError);
  });
});

describe("ProviderRegistry.resolveAvailable (circuit-breaker aware)", () => {
  it("returns primary when its circuit is closed", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());

    const resolved = await registry.resolveAvailable("tiktok", "DISCOVERY", breaker);
    expect(resolved.id).toBe("apify");
  });

  it("falls back to Bright Data when Apify's circuit is open", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());

    const key = { provider: "apify" as const, platform: "tiktok" as const, operation: "DISCOVERY" as const };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await breaker.recordFailure(key, err);
    await breaker.recordFailure(key, err);
    await breaker.recordFailure(key, err);

    const resolved = await registry.resolveAvailable("tiktok", "DISCOVERY", breaker);
    expect(resolved.id).toBe("brightdata");
  });

  it("throws when both primary and fallback circuits are open", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());

    const apifyKey = { provider: "apify" as const, platform: "tiktok" as const, operation: "DISCOVERY" as const };
    const brightdataKey = { provider: "brightdata" as const, platform: "tiktok" as const, operation: "DISCOVERY" as const };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    for (const key of [apifyKey, brightdataKey]) {
      await breaker.recordFailure(key, err);
      await breaker.recordFailure(key, err);
      await breaker.recordFailure(key, err);
    }

    await expect(registry.resolveAvailable("tiktok", "DISCOVERY", breaker)).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("throws when the only provider (Instagram, no fallback) has an open circuit", async () => {
    const apify = makeProvider("apify");
    const registry = new ProviderRegistry({ apify }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());

    const key = { provider: "apify" as const, platform: "instagram" as const, operation: "DISCOVERY" as const };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await breaker.recordFailure(key, err);
    await breaker.recordFailure(key, err);
    await breaker.recordFailure(key, err);

    await expect(registry.resolveAvailable("instagram", "DISCOVERY", breaker)).rejects.toThrow(ProviderError);
  });
});

describe("ProviderRegistry.resolveAvailable (QUOTA-aware — Phase 8/9 hotfix Part C production incident regression)", () => {
  it("without a quotaTracker, QUOTA state is invisible — behaves exactly as before (backward compatible)", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());

    // No call to resolveAvailable's 4th param at all — mirrors every
    // pre-existing caller (e.g. telegram/commands/refresh.ts).
    const resolved = await registry.resolveAvailable("tiktok", "DISCOVERY", breaker);
    expect(resolved.id).toBe("apify");
  });

  it("a QUOTA-exhausted primary does NOT trip the circuit breaker (stays closed) but IS routed around", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());
    const quotaTracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore());

    await quotaTracker.recordExhausted("apify", "tiktok", "DISCOVERY");

    // The circuit is still closed — QUOTA is not a circuit-eligible failure.
    expect(await breaker.isAvailable({ provider: "apify", platform: "tiktok", operation: "DISCOVERY" })).toBe(true);

    const resolved = await registry.resolveAvailable("tiktok", "DISCOVERY", breaker, quotaTracker);
    expect(resolved.id).toBe("brightdata");
  });

  it("Instagram (no fallback) throws when Apify is QUOTA-exhausted, even though its circuit stays closed", async () => {
    const apify = makeProvider("apify");
    const registry = new ProviderRegistry({ apify }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());
    const quotaTracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore());

    await quotaTracker.recordExhausted("apify", "instagram", "DISCOVERY");

    await expect(registry.resolveAvailable("instagram", "DISCOVERY", breaker, quotaTracker)).rejects.toThrow(ProviderError);
  });

  it("once the quota cooldown expires, the primary is usable again", async () => {
    const apify = makeProvider("apify");
    const brightdata = makeProvider("brightdata");
    const registry = new ProviderRegistry({ apify, brightdata }, DEFAULT_REGISTRY_CONFIG);
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore());
    const store = new InMemoryProviderQuotaStore();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const quotaTracker = new ProviderQuotaTracker(store, clock);

    await quotaTracker.recordExhausted("apify", "tiktok", "DISCOVERY");
    expect((await registry.resolveAvailable("tiktok", "DISCOVERY", breaker, quotaTracker)).id).toBe("brightdata");

    clock.advanceMs(6 * 60 * 60 * 1000);
    expect((await registry.resolveAvailable("tiktok", "DISCOVERY", breaker, quotaTracker)).id).toBe("apify");
  });
});
