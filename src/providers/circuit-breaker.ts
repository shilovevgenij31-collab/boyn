/**
 * Simple per (provider, platform, operation) circuit breaker (Phase 4
 * brief §17). Pure state-transition logic is separated from where the
 * state lives, so it's fully unit-testable without a database and reused
 * identically by the in-memory (tests) and DB-backed (production) stores.
 *
 * Rules (approved, not configurable per-call): 3 consecutive ELIGIBLE
 * failures opens the circuit for 6 hours; after that, one probe is
 * allowed through (`half-open`); success closes and resets the count,
 * failure reopens with a fresh 6h window. A failure only counts if
 * `isCircuitEligibleFailure` (src/providers/errors.ts) says so — BAD_INPUT/
 * AUTH/QUOTA/UNSUPPORTED never trip the breaker; those are configuration
 * or account problems, not "the provider is down".
 */
import type { Clock } from "@/lib/clock.ts";
import { systemClock } from "@/lib/clock.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderId } from "@/core/domain/provider.ts";
import { isCircuitEligibleFailure } from "./errors.ts";

export type ProviderOperation = "DISCOVERY" | "REFRESH";

export interface CircuitKey {
  provider: ProviderId;
  platform: Platform;
  operation: ProviderOperation;
}

export function circuitKeyToString(key: CircuitKey): string {
  return `circuit:${key.provider}:${key.platform}:${key.operation}`;
}

/** Persisted shape. `state` only ever stores "closed" or "open" — the
 * half-open transition is derived at read time from `openedAt`, never
 * itself written, so there's nothing to keep in sync. */
export interface CircuitRecord {
  state: "closed" | "open";
  consecutiveFailures: number;
  openedAt: Date | null;
}

export type EffectiveCircuitState = "closed" | "open" | "half-open";

export const CLOSED_CIRCUIT: CircuitRecord = { state: "closed", consecutiveFailures: 0, openedAt: null };

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 6 * 60 * 60 * 1000;

export function effectiveState(record: CircuitRecord, now: Date): EffectiveCircuitState {
  if (record.state !== "open" || !record.openedAt) return record.state === "open" ? "closed" : record.state;
  const elapsedMs = now.getTime() - record.openedAt.getTime();
  return elapsedMs >= OPEN_DURATION_MS ? "half-open" : "open";
}

export function isAvailable(record: CircuitRecord, now: Date): boolean {
  return effectiveState(record, now) !== "open";
}

/** Only mutates state for an eligible failure — an ineligible one
 * (BAD_INPUT, AUTH, ...) is a no-op, returning the record unchanged. */
export function applyFailure(record: CircuitRecord, now: Date, eligible: boolean): CircuitRecord {
  if (!eligible) return record;
  const consecutiveFailures = record.consecutiveFailures + 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    return { state: "open", consecutiveFailures, openedAt: now };
  }
  return { ...record, consecutiveFailures };
}

export function applySuccess(): CircuitRecord {
  return { ...CLOSED_CIRCUIT };
}

export interface CircuitBreakerStore {
  get(key: CircuitKey): Promise<CircuitRecord>;
  save(key: CircuitKey, record: CircuitRecord): Promise<void>;
}

/** For tests / a single process's in-memory use — NOT for production
 * (Phase 4 brief §18: state must survive a cold start). */
export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly records = new Map<string, CircuitRecord>();

  async get(key: CircuitKey): Promise<CircuitRecord> {
    return this.records.get(circuitKeyToString(key)) ?? { ...CLOSED_CIRCUIT };
  }

  async save(key: CircuitKey, record: CircuitRecord): Promise<void> {
    this.records.set(circuitKeyToString(key), record);
  }
}

/** The store + clock + eligibility rule wired together — this is what
 * callers actually use; `effectiveState`/`applyFailure`/`applySuccess`
 * above stay independently testable pure functions. */
export class CircuitBreaker {
  constructor(
    private readonly store: CircuitBreakerStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async isAvailable(key: CircuitKey): Promise<boolean> {
    const record = await this.store.get(key);
    return isAvailable(record, this.clock.now());
  }

  async recordFailure(key: CircuitKey, error: unknown): Promise<void> {
    const record = await this.store.get(key);
    const updated = applyFailure(record, this.clock.now(), isCircuitEligibleFailure(error));
    if (updated !== record) await this.store.save(key, updated);
  }

  async recordSuccess(key: CircuitKey): Promise<void> {
    await this.store.save(key, applySuccess());
  }
}
