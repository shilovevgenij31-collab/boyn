/**
 * ProviderQuotaTracker pure logic (Phase 8/9 hotfix Part C production
 * incident regression) — see registry.ts's resolveAvailable for how this
 * combines with CircuitBreaker, and db-provider-quota-store.ts for the
 * app_settings-backed durability test.
 */
import { describe, expect, it } from "vitest";
import { InMemoryProviderQuotaStore, ProviderQuotaTracker } from "@/providers/quota-tracker.ts";
import { FixedClock } from "@/lib/clock.ts";

const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("ProviderQuotaTracker", () => {
  it("a never-recorded (provider, platform, operation) is not exhausted", async () => {
    const tracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore(), new FixedClock(t0));
    expect(await tracker.isExhausted("apify", "tiktok", "DISCOVERY")).toBe(false);
  });

  it("recordExhausted marks it exhausted immediately", async () => {
    const tracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore(), new FixedClock(t0));
    await tracker.recordExhausted("apify", "instagram", "DISCOVERY");
    expect(await tracker.isExhausted("apify", "instagram", "DISCOVERY")).toBe(true);
  });

  it("expires after the cooldown window elapses", async () => {
    const clock = new FixedClock(t0);
    const tracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore(), clock);
    await tracker.recordExhausted("apify", "tiktok", "REFRESH");
    expect(await tracker.isExhausted("apify", "tiktok", "REFRESH")).toBe(true);

    clock.advanceMs(6 * 60 * 60 * 1000);
    expect(await tracker.isExhausted("apify", "tiktok", "REFRESH")).toBe(false);
  });

  it("distinct (provider, platform, operation) keys don't collide", async () => {
    const tracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore(), new FixedClock(t0));
    await tracker.recordExhausted("apify", "tiktok", "DISCOVERY");
    expect(await tracker.isExhausted("brightdata", "tiktok", "DISCOVERY")).toBe(false);
    expect(await tracker.isExhausted("apify", "instagram", "DISCOVERY")).toBe(false);
    expect(await tracker.isExhausted("apify", "tiktok", "REFRESH")).toBe(false);
  });

  it("a fresh QUOTA failure after expiry refreshes the cooldown", async () => {
    const clock = new FixedClock(t0);
    const tracker = new ProviderQuotaTracker(new InMemoryProviderQuotaStore(), clock);
    await tracker.recordExhausted("brightdata", "tiktok", "DISCOVERY");
    clock.advanceMs(6 * 60 * 60 * 1000 + 1);
    expect(await tracker.isExhausted("brightdata", "tiktok", "DISCOVERY")).toBe(false);

    await tracker.recordExhausted("brightdata", "tiktok", "DISCOVERY");
    expect(await tracker.isExhausted("brightdata", "tiktok", "DISCOVERY")).toBe(true);
  });
});
