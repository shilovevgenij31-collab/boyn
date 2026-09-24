/**
 * Production incident regression (Phase 8/9 hotfix Part C): Apify TikTok
 * discovery failed for days with a real HTTP 402 ("not-enough-usage-to-
 * run-paid-actor" — Apify's free-tier usage exhausted), classified as
 * QUOTA. Because errors.ts's isCircuitEligibleFailure deliberately
 * excludes QUOTA from circuit-breaker failure counting (an account
 * condition, not "the provider is down"), the circuit never opened and
 * registry.ts's resolveAvailable kept returning Apify as "available" —
 * so no Bright Data fallback job was ever planned, for days. This proves
 * the fix: a QUOTA failure now still routes the NEXT planning attempt to
 * the configured fallback, without ever touching the circuit breaker's
 * own state (which must keep reflecting real technical outages only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { buildTestTickContext } from "./helpers/tick-context.ts";
import { FixedClock } from "@/lib/clock.ts";
import { FixtureProvider } from "@/providers/fixture/provider.ts";
import { ProviderError } from "@/providers/errors.ts";
import type { CircuitKey } from "@/providers/circuit-breaker.ts";
import type {
  ProviderCapabilities,
  ProviderJobStatus,
  ProviderResultPage,
  SocialDataProvider,
  SubmittedProviderJob,
} from "@/providers/provider.ts";
import { planDiscovery } from "@/jobs/plan-discovery.ts";
import { submitPendingJobs } from "@/jobs/submit-jobs.ts";
import { pollJobs } from "@/jobs/poll-jobs.ts";
import { ingestReadyJobs } from "@/jobs/ingest-job.ts";
import { finalizeRuns } from "@/jobs/finalize-runs.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { appSettings, collectionRuns, hashtagCategories, hashtags, providerJobs, trackedHashtags } from "@/db/schema.ts";

/** A minimal test double whose submitDiscovery ALWAYS throws a QUOTA
 * ProviderError with a real HTTP 402 — matching production evidence
 * exactly (Apify's client.runActor throws before any externalJobId
 * exists, so submitted_at/external_job_id stay null on the FAILED row). */
class QuotaExhaustedProvider implements SocialDataProvider {
  readonly id = "apify" as const;

  capabilities(): ProviderCapabilities {
    return {
      tiktok: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
      instagram: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
    };
  }

  async submitDiscovery(): Promise<SubmittedProviderJob> {
    throw new ProviderError("QUOTA", "apify", "submitDiscovery", "apify runActor failed: HTTP 402: not-enough-usage-to-run-paid-actor", {
      httpStatus: 402,
    });
  }

  async submitRefresh(): Promise<SubmittedProviderJob> {
    throw new ProviderError("QUOTA", "apify", "submitRefresh", "apify runActor failed: HTTP 402: not-enough-usage-to-run-paid-actor", {
      httpStatus: 402,
    });
  }

  async getStatus(): Promise<ProviderJobStatus> {
    throw new ProviderError("NOT_FOUND", "apify", "getStatus", "never submitted");
  }

  async fetchResults(): Promise<ProviderResultPage> {
    throw new ProviderError("NOT_FOUND", "apify", "fetchResults", "never submitted");
  }
}

async function resetDb(db: TestDatabase): Promise<void> {
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagCategories);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
  await db.delete(appSettings);
}

async function seedCoreHashtag(db: TestDatabase, tag: string, now: Date): Promise<void> {
  const hashtagId = await upsertHashtag(db, tag, now);
  await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "CORE", source: "SEED" });
}

describe("QUOTA (HTTP 402) fallback routing — production incident regression", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetDb(db);
  });

  it("a QUOTA failure does not open the circuit, but the next same-run attempt still falls back to Bright Data and finishes PARTIAL", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new QuotaExhaustedProvider();
    const brightdataFixture = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [] }] });
    const ctx = buildTestTickContext({ db, clock, brightdata: brightdataFixture });
    // Register the QUOTA-throwing double directly (buildTestTickContext
    // only wraps FixtureProvider) by rebuilding the registry with it.
    const { ProviderRegistry, DEFAULT_REGISTRY_CONFIG } = await import("@/providers/registry.ts");
    ctx.providers = new ProviderRegistry({ apify, brightdata: ctx.providers.getById("brightdata") }, DEFAULT_REGISTRY_CONFIG);

    await planDiscovery(ctx); // attempt 1: apify chosen (circuit closed, no quota record yet)
    await submitPendingJobs(ctx); // attempt 1 fails with QUOTA -> quota tracker records it

    const apifyKey: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
    expect(await ctx.circuitBreaker.isAvailable(apifyKey)).toBe(true); // QUOTA never trips the circuit

    let jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.provider).toBe("apify");
    expect(jobs[0]?.status).toBe("FAILED");
    expect(jobs[0]?.error).toContain("402");

    await planDiscovery(ctx); // attempt 2, same run: apify circuit still closed, but QUOTA-exhausted -> routes to brightdata
    await submitPendingJobs(ctx);
    clock.advanceMs(3 * 60_000);
    await pollJobs(ctx);
    await ingestReadyJobs(ctx);
    await finalizeRuns(ctx);

    jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.provider).toBe("brightdata");
    expect(jobs[1]?.status).toBe("INGESTED");

    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.id, jobs[0]!.collectionRunId));
    expect(run?.status).toBe("PARTIAL");
  });

  it("Instagram (no configured fallback) stays FAILED when Apify is QUOTA-exhausted — no fallback is invented", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    // Instagram discovery needs a due tag too.
    const hashtagId = await upsertHashtag(db, "gaming", clock.now());
    await ensureTrackedHashtag(db, { hashtagId, platform: "instagram", market: "global", tier: "CORE", source: "SEED" });

    const apify = new QuotaExhaustedProvider();
    const ctx = buildTestTickContext({ db, clock });
    const { ProviderRegistry, DEFAULT_REGISTRY_CONFIG } = await import("@/providers/registry.ts");
    ctx.providers = new ProviderRegistry({ apify }, DEFAULT_REGISTRY_CONFIG);

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);
    await planDiscovery(ctx); // second attempt: still only apify configured, still QUOTA-exhausted
    await submitPendingJobs(ctx);
    await finalizeRuns(ctx);

    const jobs = await db.select().from(providerJobs).where(eq(providerJobs.platform, "instagram"));
    expect(jobs.every((j) => j.status === "FAILED")).toBe(true);
    expect(jobs.every((j) => j.provider === "apify")).toBe(true); // never silently switched to a non-configured provider
  });
});
