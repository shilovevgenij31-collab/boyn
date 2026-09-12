/**
 * Phase 5 state-machine integration tests (brief §56, tests A-U) — all
 * offline, PGlite-backed, driven by FixtureProvider (no network, no real
 * provider ever charged by CI — brief §59).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { buildTestTickContext, wrapFixtureAsProvider } from "./helpers/tick-context.ts";
import { FixedClock } from "@/lib/clock.ts";
import { Deadline } from "@/lib/deadline.ts";
import { FixtureProvider } from "@/providers/fixture/provider.ts";
import { ProviderError } from "@/providers/errors.ts";
import { DEFAULT_REGISTRY_CONFIG, ProviderRegistry } from "@/providers/registry.ts";
import { runTick } from "@/jobs/tick.ts";
import { planDiscovery } from "@/jobs/plan-discovery.ts";
import { planRefresh } from "@/jobs/plan-refresh.ts";
import { submitPendingJobs } from "@/jobs/submit-jobs.ts";
import { pollJobs } from "@/jobs/poll-jobs.ts";
import { ingestReadyJobs } from "@/jobs/ingest-job.ts";
import { finalizeRuns } from "@/jobs/finalize-runs.ts";
import { acquireSubmitLease, planProviderJob } from "@/db/repositories/provider-jobs.ts";
import { createCollectionRun } from "@/db/repositories/runs.ts";
import { setCollectionPaused } from "@/db/repositories/settings.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { persistNormalizedObservation } from "@/db/repositories/posts.ts";
import { normalizeApifyTikTok } from "@/providers/apify/normalize-tiktok.ts";
import {
  appSettings,
  collectionRuns,
  hashtagCategories,
  hashtags,
  postDiscoveries,
  postHashtags,
  postSnapshots,
  posts,
  providerJobs,
  quarantinedItems,
  trackedHashtags,
} from "@/db/schema.ts";
import type { CircuitKey } from "@/providers/circuit-breaker.ts";
import type { TickContext } from "@/jobs/types.ts";

function loadFixture(relativePath: string): unknown {
  const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
  return JSON.parse(readFileSync(fixturesRoot + relativePath, "utf8"));
}

const search1 = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
const search2 = loadFixture("apify/tiktok/search-2.json") as Record<string, unknown>;

async function resetDb(db: TestDatabase): Promise<void> {
  await db.delete(postDiscoveries);
  await db.delete(postSnapshots);
  await db.delete(postHashtags);
  await db.delete(quarantinedItems);
  await db.delete(posts);
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagCategories);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
  await db.delete(appSettings); // e.g. collection_paused and circuit-breaker state must not leak between tests
}

async function seedCoreHashtag(db: TestDatabase, tag: string, now: Date): Promise<{ hashtagId: number; trackedHashtagId: number }> {
  const hashtagId = await upsertHashtag(db, tag, now);
  const tracked = await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "CORE", source: "SEED" });
  return { hashtagId, trackedHashtagId: tracked.id };
}

describe("Phase 5 tick state machine", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetDb(db);
  });

  it("A: planning the same discovery slot twice creates exactly one collection_run and one provider_job per platform", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }, { runningPolls: 0, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await planDiscovery(ctx);

    // Two platforms (tiktok, instagram) each get their own slot/run —
    // tiktok has a due CORE tag and gets a job; instagram has none, so its
    // run is SKIPPED with zero jobs. Re-planning must not duplicate either.
    const runs = await db.select().from(collectionRuns);
    const jobs = await db.select().from(providerJobs);
    expect(runs).toHaveLength(2);
    expect(jobs).toHaveLength(1);
  });

  it("D: a successful submit persists the external job id and moves the job to SUBMITTED", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    const result = await submitPendingJobs(ctx);

    expect(result.submitted).toBe(1);
    const [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("SUBMITTED");
    expect(job?.externalJobId).toBeTruthy();
    expect(job?.webhookToken).toBeTruthy();
  });

  it("E: a submit failure marks the job FAILED and records a circuit failure", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [] }); // no planned jobs -> submitDiscovery throws
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    const result = await submitPendingJobs(ctx);

    expect(result.failed).toBe(1);
    const [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("FAILED");
    expect(job?.error).toBeTruthy();
  });

  it("a run's failed first attempt gets one same-run retry, which can land on a fallback and finish PARTIAL", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [] }); // every submitDiscovery call throws
    const brightdata = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [] }] });
    const ctx = buildTestTickContext({ db, clock, apify, brightdata });

    // Two failures already on apify's record from earlier, unrelated
    // runs — this run's own first attempt will be the third.
    const apifyKey: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
    const priorErr = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "earlier outage");
    await ctx.circuitBreaker.recordFailure(apifyKey, priorErr);
    await ctx.circuitBreaker.recordFailure(apifyKey, priorErr);

    await planDiscovery(ctx); // attempt 1: apify still closed, chosen, planned
    await submitPendingJobs(ctx); // attempt 1 fails -> 3rd consecutive failure -> circuit opens

    let jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("FAILED");

    await planDiscovery(ctx); // attempt 2, same run: apify circuit now open -> routes to brightdata
    await submitPendingJobs(ctx);
    clock.advanceMs(3 * 60_000); // brightdata's poll interval is longer than apify's
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

  it("B/C: submit leases prevent a concurrent double-submit, and an expired lease is reclaimable", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: "discovery:tiktok:global:test-bc", plannedAt: clock.now() });
    const jobId = await planProviderJob(db, {
      collectionRunId: run.id,
      provider: "apify",
      platform: "tiktok",
      jobType: "HASHTAG_DISCOVERY",
      input: { queries: [], limitPerQuery: 15 },
    });

    const leaseUntil = new Date(clock.now().getTime() + 5 * 60_000);
    const workerA = await acquireSubmitLease(db, jobId, clock.now(), leaseUntil);
    const workerB = await acquireSubmitLease(db, jobId, clock.now(), leaseUntil);
    expect(workerA).toBe(true);
    expect(workerB).toBe(false);

    clock.advanceMs(6 * 60_000);
    const workerC = await acquireSubmitLease(db, jobId, clock.now(), new Date(clock.now().getTime() + 5 * 60_000));
    expect(workerC).toBe(true);
  });

  it("H/I/S: a RUNNING job stays pollable across ticks and reaches READY on a later poll (multi-tick job)", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 2, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);

    clock.advanceMs(2 * 60_000);
    const poll1 = await pollJobs(ctx);
    expect(poll1.polled).toBe(1);
    let [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("RUNNING");

    // The collection run must stay open — it spans multiple ticks.
    const [run] = await db.select().from(collectionRuns);
    expect(run?.status).toBe("RUNNING");

    clock.advanceMs(2 * 60_000);
    const poll2 = await pollJobs(ctx);
    expect(poll2.polled).toBe(1);
    [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("RUNNING");

    clock.advanceMs(2 * 60_000);
    const poll3 = await pollJobs(ctx);
    expect(poll3.becameReady).toBe(1);
    [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("READY");
  });

  it("J/K: ingestion persists valid items and quarantines a malformed one without losing the good ones", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const malformed = { text: "no id field here" };
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1, malformed] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);
    clock.advanceMs(2 * 60_000);
    await pollJobs(ctx);
    const ingestResult = await ingestReadyJobs(ctx);

    expect(ingestResult.itemsPersisted).toBe(1);
    expect(ingestResult.itemsQuarantined).toBe(1);

    const postRows = await db.select().from(posts);
    const quarantineRows = await db.select().from(quarantinedItems);
    expect(postRows).toHaveLength(1);
    expect(quarantineRows).toHaveLength(1);

    const [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("INGESTED");
    expect(job?.recordsReturned).toBe(1);
    expect(job?.recordsQuarantined).toBe(1);
  });

  it("L: ingesting the same READY job twice is idempotent (a second ingest attempt is a no-op)", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);
    clock.advanceMs(2 * 60_000);
    await pollJobs(ctx);
    const first = await ingestReadyJobs(ctx);
    expect(first.ingested).toBe(1);

    const second = await ingestReadyJobs(ctx);
    expect(second.ingested).toBe(0); // job is already INGESTED, not selected again

    const postRows = await db.select().from(posts);
    expect(postRows).toHaveLength(1);
  });

  it("M: the same post rediscovered later keeps one post row and adds a legitimate new snapshot", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    const context = { observedAt: clock.now(), discoveryMethod: "search" };
    const first = normalizeApifyTikTok(search1, context);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstPersist = await persistNormalizedObservation(db, { post: first.post, snapshotSource: "DISCOVERY" });

    clock.advanceMs(10 * 60_000);
    const changed = { ...search1, playCount: (search1.playCount as number) + 500 };
    const second = normalizeApifyTikTok(changed, { observedAt: clock.now(), discoveryMethod: "search" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondPersist = await persistNormalizedObservation(db, { post: second.post, snapshotSource: "DISCOVERY" });

    expect(secondPersist.postId).toBe(firstPersist.postId);
    const snapshots = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, firstPersist.postId));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const postRows = await db.select().from(posts);
    expect(postRows).toHaveLength(1);
  });

  it("N: a hard monthly budget stop prevents a new discovery job from being submitted", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: "discovery:tiktok:global:budget-test", plannedAt: clock.now() });
    await db.insert(providerJobs).values({
      collectionRunId: run.id,
      provider: "apify",
      platform: "tiktok",
      jobType: "HASHTAG_DISCOVERY",
      status: "INGESTED",
      submittedAt: clock.now(),
      recordsReturned: 5,
      costEstUsd: "1.00",
    });

    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify, budgetProfile: "FREE" }); // FREE monthlyUsdMax = 1

    const outcome = await planDiscovery(ctx);
    expect(outcome.jobsPlanned).toBe(0);
    expect(outcome.partialReasons).toContain("BUDGET_EXHAUSTED");
  });

  it("F: TikTok discovery falls back to Bright Data once Apify's circuit is open", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [] });
    const brightdata = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [] }] });
    const ctx = buildTestTickContext({ db, clock, apify, brightdata });

    const apifyKey: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await ctx.circuitBreaker.recordFailure(apifyKey, err);
    await ctx.circuitBreaker.recordFailure(apifyKey, err);
    await ctx.circuitBreaker.recordFailure(apifyKey, err);

    const outcome = await planDiscovery(ctx);
    expect(outcome.jobsPlanned).toBe(1);
    const [job] = await db.select().from(providerJobs);
    expect(job?.provider).toBe("brightdata");
  });

  it("G: an Instagram outage with no fallback configured produces PROVIDER_UNAVAILABLE, never a fabricated fallback", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    const hashtagId = await upsertHashtag(db, "cosplay", clock.now());
    await ensureTrackedHashtag(db, { hashtagId, platform: "instagram", market: "global", tier: "CORE", source: "SEED" });
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [] }] });
    const ctx = buildTestTickContext({ db, clock, apify }); // no brightdata registered at all

    const igKey: CircuitKey = { provider: "apify", platform: "instagram", operation: "DISCOVERY" };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await ctx.circuitBreaker.recordFailure(igKey, err);
    await ctx.circuitBreaker.recordFailure(igKey, err);
    await ctx.circuitBreaker.recordFailure(igKey, err);

    const outcome = await planDiscovery(ctx);
    const jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(0);
    expect(outcome.partialReasons).toContain("PROVIDER_UNAVAILABLE");
  });

  it("O: an open circuit for the only configured provider blocks submission without ever calling it", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] }); // would succeed if called
    const ctx = buildTestTickContext({ db, clock, apify }); // no brightdata fallback registered

    const key: CircuitKey = { provider: "apify", platform: "tiktok", operation: "DISCOVERY" };
    const err = new ProviderError("UPSTREAM", "apify", "DISCOVERY", "boom");
    await ctx.circuitBreaker.recordFailure(key, err);
    await ctx.circuitBreaker.recordFailure(key, err);
    await ctx.circuitBreaker.recordFailure(key, err);

    const outcome = await planDiscovery(ctx);
    expect(outcome.jobsPlanned).toBe(0);
    const jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(0);
  });

  it("P: pause mode blocks new submissions but a tick still reconciles already-running work", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    // Pre-existing in-flight work planned before the pause.
    await planDiscovery(ctx);
    await submitPendingJobs(ctx);

    await setCollectionPaused(db, true, clock.now());
    clock.advanceMs(2 * 60_000);

    const tickResult = await runTick(ctx);
    expect(tickResult.partialReasons).toContain("COLLECTION_PAUSED");
    // No NEW discovery job was planned for a fresh slot/tag.
    const jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(1);
    // But the existing job WAS reconciled (polled + ingested) even while paused.
    const [job] = jobs;
    expect(job?.status).toBe("INGESTED");
  });

  it("Q: a tick with an already-expired deadline exits safely without throwing", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1] }] });
    const deadline = new Deadline(10, clock);
    clock.advanceMs(50); // deadline is now already expired

    const ctx: TickContext = {
      db,
      providers: new ProviderRegistry({ apify: wrapFixtureAsProvider("apify", apify) }, DEFAULT_REGISTRY_CONFIG),
      circuitBreaker: buildTestTickContext({ db, clock, apify }).circuitBreaker,
      clock,
      deadline,
      market: "global",
      budgetProfile: "STANDARD",
    };

    const result = await runTick(ctx);
    expect(result.partialReasons).toContain("DEADLINE");
    const jobs = await db.select().from(providerJobs);
    expect(jobs).toHaveLength(0); // nothing new was planned
  });

  it("R: an empty provider result is a valid completion, not an error", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);
    clock.advanceMs(2 * 60_000);
    await pollJobs(ctx);
    const ingestResult = await ingestReadyJobs(ctx);
    expect(ingestResult.ingested).toBe(1);
    expect(ingestResult.itemsPersisted).toBe(0);

    const [job] = await db.select().from(providerJobs);
    expect(job?.status).toBe("INGESTED");
    expect(job?.recordsReturned).toBe(0);
  });

  it("T: a TikTok refresh produces a new snapshot and updates refresh metadata; U: Instagram never gets a refresh job", async () => {
    // search1's real publishedAt is 2026-09-12T16:49:57Z (Phase 4 smoke
    // capture) — the clock must start after that for refresh eligibility's
    // age check (0.5-48h) to see it as a recent, not-yet-future post.
    const clock = new FixedClock(new Date("2026-09-12T20:00:00.000Z"));
    const discovered = normalizeApifyTikTok(search1, { observedAt: clock.now(), discoveryMethod: "search" });
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    // Give it enough views to clear the refresh eligibility floor.
    const boosted = { ...discovered.post, metrics: { ...discovered.post.metrics, views: 50_000 } };
    const { postId } = await persistNormalizedObservation(db, { post: boosted, snapshotSource: "DISCOVERY" });

    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [{ ...search1, playCount: 99_000 }] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planRefresh(ctx);
    await submitPendingJobs(ctx);
    clock.advanceMs(2 * 60_000);
    await pollJobs(ctx);
    await ingestReadyJobs(ctx);

    const [postRow] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(postRow?.paidRefreshCount).toBe(1);
    expect(postRow?.lastRefreshedAt).not.toBeNull();
    expect(postRow?.nextRefreshAt).not.toBeNull();

    const snapshots = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    expect(snapshots.some((s) => s.source === "REFRESH")).toBe(true);

    // U: no refresh collection_run ever targets instagram.
    const refreshRuns = await db.select().from(collectionRuns).where(eq(collectionRuns.kind, "REFRESH"));
    expect(refreshRuns.every((r) => r.slotKey.includes(":tiktok:"))).toBe(true);
  });

  it("distinct discovery items across two runs both persist without cross-contamination", async () => {
    const clock = new FixedClock(new Date("2026-09-12T05:00:00.000Z"));
    await seedCoreHashtag(db, "cosplay", clock.now());
    const apify = new FixtureProvider({ clock, jobs: [{ runningPolls: 0, items: [search1, search2] }] });
    const ctx = buildTestTickContext({ db, clock, apify });

    await planDiscovery(ctx);
    await submitPendingJobs(ctx);
    clock.advanceMs(2 * 60_000);
    await pollJobs(ctx);
    const ingestResult = await ingestReadyJobs(ctx);

    expect(ingestResult.itemsPersisted).toBe(2);
    const postRows = await db.select().from(posts);
    expect(postRows).toHaveLength(2);
    expect(new Set(postRows.map((p) => p.externalId)).size).toBe(2);
  });
});
