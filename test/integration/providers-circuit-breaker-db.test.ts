/**
 * Proves circuit-breaker state actually survives via app_settings (PGlite)
 * — the durability requirement a Vercel cold start depends on (Phase 4
 * brief §18), including the Date <-> ISO-string round trip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { CircuitBreaker, CLOSED_CIRCUIT, type CircuitKey } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import { ProviderError } from "@/providers/errors.ts";
import { FixedClock } from "@/lib/clock.ts";

const KEY: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("DbCircuitBreakerStore (PGlite-backed, app_settings)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("get() on a never-seen key returns the closed default, without writing anything", async () => {
    const store = new DbCircuitBreakerStore(db);
    const record = await store.get(KEY);
    expect(record).toEqual(CLOSED_CIRCUIT);
  });

  it("save() then get() round-trips state exactly, including the Date openedAt field", async () => {
    const store = new DbCircuitBreakerStore(db);
    await store.save(KEY, { state: "open", consecutiveFailures: 3, openedAt: t0 });

    const record = await store.get(KEY);
    expect(record.state).toBe("open");
    expect(record.consecutiveFailures).toBe(3);
    expect(record.openedAt).toBeInstanceOf(Date);
    expect(record.openedAt?.toISOString()).toBe(t0.toISOString());
  });

  it("a closed record with openedAt:null round-trips without becoming an invalid Date", async () => {
    const store = new DbCircuitBreakerStore(db);
    await store.save(KEY, CLOSED_CIRCUIT);
    const record = await store.get(KEY);
    expect(record.openedAt).toBeNull();
  });

  it("state persists across a fresh DbCircuitBreakerStore instance pointed at the same db — simulates surviving a cold start", async () => {
    const firstInstance = new DbCircuitBreakerStore(db);
    await firstInstance.save(KEY, { state: "open", consecutiveFailures: 3, openedAt: t0 });

    const secondInstance = new DbCircuitBreakerStore(db);
    const record = await secondInstance.get(KEY);
    expect(record.state).toBe("open");
  });

  it("a full CircuitBreaker lifecycle persists through the DB store: opens, blocks, half-opens, and closes on success", async () => {
    const store = new DbCircuitBreakerStore(db);
    const clock = new FixedClock(t0);
    const breaker = new CircuitBreaker(store, clock);
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");

    await breaker.recordFailure(KEY, err);
    await breaker.recordFailure(KEY, err);
    await breaker.recordFailure(KEY, err);
    expect(await breaker.isAvailable(KEY)).toBe(false);

    // A brand-new CircuitBreaker instance sharing the same db/store must
    // see the same open state — this is the actual "survives a cold
    // start" property, not just object identity within one process.
    const rehydratedBreaker = new CircuitBreaker(new DbCircuitBreakerStore(db), clock);
    expect(await rehydratedBreaker.isAvailable(KEY)).toBe(false);

    clock.advanceMs(6 * 60 * 60 * 1000);
    expect(await rehydratedBreaker.isAvailable(KEY)).toBe(true);

    await rehydratedBreaker.recordSuccess(KEY);
    const finalRecord = await store.get(KEY);
    expect(finalRecord).toEqual(CLOSED_CIRCUIT);
  });

  it("different circuit keys are stored under distinct app_settings rows and don't collide", async () => {
    const store = new DbCircuitBreakerStore(db);
    const otherKey: CircuitKey = { provider: "brightdata", platform: "tiktok", operation: "DISCOVERY" };

    await store.save(KEY, { state: "open", consecutiveFailures: 3, openedAt: t0 });
    await store.save(otherKey, CLOSED_CIRCUIT);

    expect((await store.get(KEY)).state).toBe("open");
    expect((await store.get(otherKey)).state).toBe("closed");
  });
});
