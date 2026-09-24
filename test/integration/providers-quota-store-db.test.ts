/**
 * Proves QUOTA-tracker state actually survives via app_settings (PGlite)
 * — the same "must survive a Vercel cold start" durability requirement
 * circuit-breaker state already has (Phase 4 brief §18) — Phase 8/9
 * hotfix Part C production incident regression.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { DbProviderQuotaStore } from "@/providers/db-provider-quota-store.ts";
import { ProviderQuotaTracker, type QuotaKey } from "@/providers/quota-tracker.ts";
import { FixedClock } from "@/lib/clock.ts";

const KEY: QuotaKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("DbProviderQuotaStore (PGlite-backed, app_settings)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("get() on a never-seen key returns null, without writing anything", async () => {
    const store = new DbProviderQuotaStore(db);
    expect(await store.get(KEY)).toBeNull();
  });

  it("save() then get() round-trips the recordedAt Date exactly", async () => {
    const store = new DbProviderQuotaStore(db);
    await store.save(KEY, t0);
    const recordedAt = await store.get(KEY);
    expect(recordedAt).toBeInstanceOf(Date);
    expect(recordedAt?.toISOString()).toBe(t0.toISOString());
  });

  it("state persists across a fresh DbProviderQuotaStore instance pointed at the same db — simulates surviving a cold start", async () => {
    const first = new DbProviderQuotaStore(db);
    await first.save(KEY, t0);

    const second = new DbProviderQuotaStore(db);
    expect((await second.get(KEY))?.toISOString()).toBe(t0.toISOString());
  });

  it("a full ProviderQuotaTracker lifecycle persists through the DB store and expires after the cooldown", async () => {
    const store = new DbProviderQuotaStore(db);
    const clock = new FixedClock(t0);
    const tracker = new ProviderQuotaTracker(store, clock);

    await tracker.recordExhausted("brightdata", "instagram", "DISCOVERY");
    expect(await tracker.isExhausted("brightdata", "instagram", "DISCOVERY")).toBe(true);

    // A brand-new tracker sharing the same db/store must see the same
    // exhausted state — the actual "survives a cold start" property.
    const rehydrated = new ProviderQuotaTracker(new DbProviderQuotaStore(db), clock);
    expect(await rehydrated.isExhausted("brightdata", "instagram", "DISCOVERY")).toBe(true);

    clock.advanceMs(6 * 60 * 60 * 1000);
    expect(await rehydrated.isExhausted("brightdata", "instagram", "DISCOVERY")).toBe(false);
  });

  it("different quota keys are stored under distinct app_settings rows and don't collide", async () => {
    const store = new DbProviderQuotaStore(db);
    const otherKey: QuotaKey = { provider: "brightdata", platform: "tiktok", operation: "DISCOVERY" };

    await store.save(KEY, t0);
    expect(await store.get(otherKey)).toBeNull();
    expect((await store.get(KEY))?.toISOString()).toBe(t0.toISOString());
  });
});
