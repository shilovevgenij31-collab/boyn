import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applySuccess,
  CircuitBreaker,
  CLOSED_CIRCUIT,
  effectiveState,
  InMemoryCircuitBreakerStore,
  isAvailable,
  type CircuitKey,
  type CircuitRecord,
} from "@/providers/circuit-breaker.ts";
import { FixedClock } from "@/lib/clock.ts";
import { ProviderError } from "@/providers/errors.ts";

const KEY: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
const t0 = new Date("2026-01-01T00:00:00Z");

describe("pure circuit-breaker state transitions", () => {
  it("stays closed on fewer than 3 consecutive eligible failures", () => {
    let record = CLOSED_CIRCUIT;
    record = applyFailure(record, t0, true);
    record = applyFailure(record, t0, true);
    expect(record.state).toBe("closed");
    expect(record.consecutiveFailures).toBe(2);
    expect(isAvailable(record, t0)).toBe(true);
  });

  it("opens on the 3rd consecutive eligible failure", () => {
    let record: CircuitRecord = CLOSED_CIRCUIT;
    record = applyFailure(record, t0, true);
    record = applyFailure(record, t0, true);
    record = applyFailure(record, t0, true);
    expect(record.state).toBe("open");
    expect(record.consecutiveFailures).toBe(3);
    expect(record.openedAt).toEqual(t0);
    expect(isAvailable(record, t0)).toBe(false);
  });

  it("an ineligible failure (e.g. BAD_INPUT) never counts and never opens the circuit", () => {
    let record: CircuitRecord = CLOSED_CIRCUIT;
    record = applyFailure(record, t0, false);
    record = applyFailure(record, t0, false);
    record = applyFailure(record, t0, false);
    record = applyFailure(record, t0, false);
    expect(record).toEqual(CLOSED_CIRCUIT);
    expect(isAvailable(record, t0)).toBe(true);
  });

  it("stays open before the 6h window elapses", () => {
    const record: CircuitRecord = { state: "open", consecutiveFailures: 3, openedAt: t0 };
    const almostSixHoursLater = new Date(t0.getTime() + 6 * 60 * 60 * 1000 - 1000);
    expect(effectiveState(record, almostSixHoursLater)).toBe("open");
    expect(isAvailable(record, almostSixHoursLater)).toBe(false);
  });

  it("becomes half-open exactly at/after the 6h window, allowing a probe", () => {
    const record: CircuitRecord = { state: "open", consecutiveFailures: 3, openedAt: t0 };
    const sixHoursLater = new Date(t0.getTime() + 6 * 60 * 60 * 1000);
    expect(effectiveState(record, sixHoursLater)).toBe("half-open");
    expect(isAvailable(record, sixHoursLater)).toBe(true);
  });

  it("a success (probe or otherwise) always closes and fully resets the record", () => {
    const record = applySuccess();
    expect(record).toEqual(CLOSED_CIRCUIT);
  });

  it("a failed probe (half-open -> failure) reopens with a fresh timer", () => {
    const halfOpenRecord: CircuitRecord = { state: "open", consecutiveFailures: 3, openedAt: t0 };
    const probeTime = new Date(t0.getTime() + 7 * 60 * 60 * 1000);
    const updated = applyFailure(halfOpenRecord, probeTime, true);
    expect(updated.state).toBe("open");
    expect(updated.openedAt).toEqual(probeTime);
    expect(effectiveState(updated, probeTime)).toBe("open");
  });
});

describe("CircuitBreaker (store + clock wiring)", () => {
  it("recordFailure x3 with eligible errors opens the circuit; isAvailable then reports false", async () => {
    const store = new InMemoryCircuitBreakerStore();
    const clock = new FixedClock(t0);
    const breaker = new CircuitBreaker(store, clock);

    const upstreamError = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await breaker.recordFailure(KEY, upstreamError);
    await breaker.recordFailure(KEY, upstreamError);
    expect(await breaker.isAvailable(KEY)).toBe(true);
    await breaker.recordFailure(KEY, upstreamError);
    expect(await breaker.isAvailable(KEY)).toBe(false);
  });

  it("BAD_INPUT failures never open the circuit even after many occurrences", async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, new FixedClock(t0));
    const badInput = new ProviderError("BAD_INPUT", "apify", "DISCOVERY", "bad query");
    for (let i = 0; i < 10; i++) await breaker.recordFailure(KEY, badInput);
    expect(await breaker.isAvailable(KEY)).toBe(true);
  });

  it("after the open window elapses, a probe is allowed, and success closes the circuit", async () => {
    const store = new InMemoryCircuitBreakerStore();
    const clock = new FixedClock(t0);
    const breaker = new CircuitBreaker(store, clock);
    const upstreamError = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");

    await breaker.recordFailure(KEY, upstreamError);
    await breaker.recordFailure(KEY, upstreamError);
    await breaker.recordFailure(KEY, upstreamError);
    expect(await breaker.isAvailable(KEY)).toBe(false);

    clock.advanceMs(6 * 60 * 60 * 1000);
    expect(await breaker.isAvailable(KEY)).toBe(true);

    await breaker.recordSuccess(KEY);
    expect(await breaker.isAvailable(KEY)).toBe(true);
    const stored = await store.get(KEY);
    expect(stored).toEqual(CLOSED_CIRCUIT);
  });

  it("different (provider, platform, operation) keys are tracked independently", async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, new FixedClock(t0));
    const upstreamError = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    const otherKey: CircuitKey = { provider: "brightdata", platform: "tiktok", operation: "DISCOVERY" };

    await breaker.recordFailure(KEY, upstreamError);
    await breaker.recordFailure(KEY, upstreamError);
    await breaker.recordFailure(KEY, upstreamError);
    expect(await breaker.isAvailable(KEY)).toBe(false);
    expect(await breaker.isAvailable(otherKey)).toBe(true);
  });
});
