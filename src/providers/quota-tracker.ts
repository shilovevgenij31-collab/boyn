/**
 * Tracks HTTP 402 / QUOTA provider failures per (provider, platform,
 * operation) — separate from CircuitBreaker (Phase 8/9 hotfix, production
 * incident Part C).
 *
 * Why not just the circuit breaker: errors.ts's isCircuitEligibleFailure
 * deliberately excludes QUOTA from circuit-breaker failure counting — an
 * account/billing condition isn't the same signal as a technical outage,
 * and circuit-breaker.ts's own module comment says its state is meant to
 * reflect "the provider is down", not a configuration/account problem.
 * But a provider stuck at QUOTA is still genuinely unusable right now,
 * and registry.ts's resolveAvailable() needs a way to route around it to
 * a configured fallback (production evidence: Apify TikTok discovery was
 * failing on every attempt with HTTP 402 "not-enough-usage-to-run-paid-
 * actor" for days, the circuit never opened because QUOTA isn't circuit-
 * eligible, and no Bright Data fallback job was ever planned). This is
 * that second, independent "is it usable" signal.
 *
 * Store/logic split mirrors circuit-breaker.ts exactly (pure logic here,
 * zero DB dependency, trivially unit-testable; db-provider-quota-store.ts
 * holds the app_settings-backed persistence — no new table needed).
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderId } from "@/core/domain/provider.ts";
import type { Clock } from "@/lib/clock.ts";
import { systemClock } from "@/lib/clock.ts";
import type { ProviderOperation } from "./circuit-breaker.ts";

/** Matches CircuitBreaker's OPEN_DURATION_MS — after this long, a
 * quota-exhausted provider is worth probing again (the next planning
 * pass simply tries it; a fresh QUOTA failure refreshes the cooldown). */
export const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface QuotaKey {
  provider: ProviderId;
  platform: Platform;
  operation: ProviderOperation;
}

export function quotaKeyToString(key: QuotaKey): string {
  return `provider_quota:${key.provider}:${key.platform}:${key.operation}`;
}

export interface ProviderQuotaStore {
  /** The instant the QUOTA failure was recorded, or `null` if none is on file. */
  get(key: QuotaKey): Promise<Date | null>;
  save(key: QuotaKey, recordedAt: Date): Promise<void>;
}

/** For tests only — NOT for production (state must survive a cold start;
 * see DbProviderQuotaStore). */
export class InMemoryProviderQuotaStore implements ProviderQuotaStore {
  private readonly records = new Map<string, Date>();

  async get(key: QuotaKey): Promise<Date | null> {
    return this.records.get(quotaKeyToString(key)) ?? null;
  }

  async save(key: QuotaKey, recordedAt: Date): Promise<void> {
    this.records.set(quotaKeyToString(key), recordedAt);
  }
}

export class ProviderQuotaTracker {
  constructor(
    private readonly store: ProviderQuotaStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async isExhausted(provider: ProviderId, platform: Platform, operation: ProviderOperation): Promise<boolean> {
    const recordedAt = await this.store.get({ provider, platform, operation });
    if (!recordedAt) return false;
    return this.clock.now().getTime() - recordedAt.getTime() < QUOTA_COOLDOWN_MS;
  }

  async recordExhausted(provider: ProviderId, platform: Platform, operation: ProviderOperation): Promise<void> {
    await this.store.save({ provider, platform, operation }, this.clock.now());
  }
}
