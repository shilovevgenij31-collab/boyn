/**
 * Phase 5 deliverable (brief §38-39, §58): a deterministic, fully offline
 * multi-day simulation of the tick pipeline — FixtureProvider, PGlite, an
 * injected FixedClock, no network, no secrets. Exported as a plain
 * function so both scripts/simulate.ts (CLI, prints a summary) and
 * test/integration/simulation.test.ts (asserts on it) drive the exact
 * same engine.
 *
 * Deliberately TikTok-only taxonomy: FixtureProvider's job queue is a flat
 * FIFO consumed by whichever call (discovery or refresh, any platform)
 * happens to run next, so a shared apify instance serving both TikTok and
 * Instagram discovery would need queue entries interleaved in an order
 * this script can't fully predict (real due-tag selection decides it).
 * Restricting the simulated taxonomy to TikTok keeps every consumed item
 * exactly the shape the caller expects. Instagram's own path (primary-
 * only, no fallback) is already covered by real integration tests
 * (test/integration/jobs-tick.test.ts, tests G/O) — this script's job is
 * to prove the multi-tick state machine, not re-prove per-platform
 * routing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema.ts";
import { collectionRuns, hashtagCooccurrenceDaily, hashtagDailyStats, hashtags, postSnapshots, posts, providerJobs, quarantinedItems } from "@/db/schema.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { FixedClock } from "@/lib/clock.ts";
import { Deadline } from "@/lib/deadline.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { FixtureProvider, type FixtureJobPlan } from "@/providers/fixture/provider.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import { ProviderQuotaTracker } from "@/providers/quota-tracker.ts";
import { DbProviderQuotaStore } from "@/providers/db-provider-quota-store.ts";
import { DEFAULT_REGISTRY_CONFIG, ProviderRegistry } from "@/providers/registry.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import { runTick } from "@/jobs/tick.ts";
import type { TickContext, TickResult } from "@/jobs/types.ts";
import { runAnalytics, type AnalyticsStats } from "@/jobs/run-analytics.ts";
import { generateDailyReport } from "@/jobs/generate-daily-report.ts";
import { runRetention } from "@/jobs/retention.ts";
import { getDailyReport } from "@/db/repositories/reports.ts";
import { exportCsv } from "@/core/report/export-csv.ts";
import { exportJson } from "@/core/report/export-json.ts";
import { exportMarkdown } from "@/core/report/export-markdown.ts";

type TestDatabase = PgliteDatabase<typeof schema>;

const FIXTURES_ROOT = resolve(process.cwd(), "test/fixtures");
function loadFixture(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES_ROOT, relativePath), "utf8"));
}

function wrapFixtureAsProvider(id: "apify" | "brightdata", fixture: FixtureProvider): SocialDataProvider {
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

export interface SimulationOptions {
  days?: number;
  tickIntervalMinutes?: number;
  startAt?: Date;
}

export interface SimulationSummary {
  ticks: number;
  collectionRuns: number;
  runsByStatus: Record<string, number>;
  providerJobsCreated: number;
  jobsByStatus: Record<string, number>;
  postsPersisted: number;
  distinctHashtagsTracked: number;
  snapshotsTotal: number;
  refreshSnapshots: number;
  quarantinedItemCount: number;
  partialRunOccurred: boolean;
  delayedJobCompletedAcrossTicks: boolean;
  replay: { jobsBeforeReplay: number; jobsAfterReplay: number; noDuplicatesCreated: boolean };
  offlineOnly: true;
  // ---- Phase 6: analytics run periodically through the same simulated
  // ticks (see runAnalytics calls below) — these totals are summed across
  // every analytics invocation in the run, not just the last one. ----
  analyticsRuns: number;
  postsScored: number;
  hashtagDailyStatsRows: number;
  cooccurrenceRows: number;
  tierPromotions: number;
  tierDemotions: number;
  refreshPlansUpdated: number;
  // ---- Phase 7: one DailyReport generated the day before the end of the
  // run and one at the very end (brief §66), so the second exercises a
  // real vsYesterday comparison — plus a smoke test of every export and a
  // final retention sweep, all against the same live simulated state. ----
  report: {
    generated: boolean;
    status: "COMPLETE" | "PARTIAL" | null;
    todayTopCount: number;
    stillHotCount: number;
    risingNowCount: number;
    hasYesterdayComparison: boolean;
    clustersCount: number;
    exportsValid: boolean;
  };
  retentionRanCleanly: boolean;
}

/** Clones a real captured TikTok item with a new id/author/view count —
 * used to deterministically manufacture Phase 6 lifecycle evidence (a
 * genuinely VIRAL_QUALIFIED post, still shaped exactly like a real Apify
 * TikTok item so it goes through the real schema/normalizer unmodified)
 * rather than hand-rolling a synthetic payload from scratch. */
function boostedClone(base: Record<string, unknown>, params: { id: string; authorId: string; authorName: string; playCount: number; hashtagName: string }): Record<string, unknown> {
  return {
    ...base,
    id: params.id,
    webVideoUrl: `https://www.tiktok.com/@${params.authorName}/video/${params.id}`,
    authorMeta: { ...(base.authorMeta as Record<string, unknown>), id: params.authorId, name: params.authorName, uniqueId: params.authorName },
    playCount: params.playCount,
    diggCount: Math.round(params.playCount * 0.05),
    commentCount: Math.round(params.playCount * 0.002),
    shareCount: Math.round(params.playCount * 0.01),
    hashtags: [{ id: "9999", name: params.hashtagName }],
  };
}

/** A large, deliberately over-provisioned pool so the queue never
 * exhausts unexpectedly across 144+ ticks — running out is a script bug,
 * not something to paper over (see FixtureProvider's own module comment). */
function buildApifyDiscoveryPlans(): FixtureJobPlan[] {
  const search = [1, 2, 3, 4, 5].map((n) => loadFixture(`apify/tiktok/search-${n}.json`));
  const plans: FixtureJobPlan[] = [
    // Index 0: one injected provider failure (brief §38) — this is
    // deliberately the very FIRST submission the simulation will ever
    // make (tick 0's discovery run), so its outcome is deterministic
    // regardless of due-tag/refresh timing elsewhere. Submits fine, but
    // the vendor reports FAILED on the first poll (tick 1).
    { runningPolls: 5, failAfter: 1, items: [] },
    // Index 1: consumed by the SAME run's same-run retry (plan-discovery
    // .ts's MAX_JOB_ATTEMPTS_PER_RUN logic, tick 1) — one deliberately
    // delayed job (brief §38): needs 2 polls (2 real ticks, 30 min apart)
    // before READY, demonstrating a job that spans multiple ticks. Its
    // eventual success alongside index 0's failure is what makes that
    // run's finalize-runs.ts outcome genuinely PARTIAL, not just FAILED.
    { runningPolls: 1, items: [search[0]!] },
    // Index 2-3: two genuinely VIRAL_QUALIFIED posts (real schema, boosted
    // views), tagged #pcgaming, from two distinct authors — the real
    // evidence Phase 6's lifecycle logic needs to promote the seeded
    // EXPLORATION "pcgaming" tag to ACTIVE (brief §66: caused by real
    // evidence, never a hard-coded tier mutation).
    { runningPolls: 0, items: [boostedClone(search[1]!, { id: "9000000000000000001", authorId: "9000000001", authorName: "pcbuilder1", playCount: 150_000, hashtagName: "pcgaming" })] },
    { runningPolls: 0, items: [boostedClone(search[2]!, { id: "9000000000000000002", authorId: "9000000002", authorName: "pcbuilder2", playCount: 200_000, hashtagName: "pcgaming" })] },
  ];

  for (let i = 0; i < 400; i++) {
    plans.push({ runningPolls: 0, items: [search[i % search.length]!] });
  }
  return plans;
}

function buildBrightDataFallbackPlans(): FixtureJobPlan[] {
  const sample = [1, 2, 3, 4, 5].map((n) => loadFixture(`brightdata/tiktok/sample-1b-${n}.json`));
  return Array.from({ length: 50 }, (_, i) => ({ runningPolls: 0, items: [sample[i % sample.length]!] }));
}

async function seedSimulationTaxonomy(db: TestDatabase, now: Date): Promise<void> {
  const seeds: { tag: string; tier: "CORE" | "ACTIVE" | "EXPLORATION" | "DORMANT" }[] = [
    { tag: "cosplay", tier: "CORE" },
    { tag: "gaming", tier: "CORE" },
    { tag: "streamer", tier: "ACTIVE" },
    { tag: "pcgaming", tier: "EXPLORATION" },
    { tag: "playstation", tier: "DORMANT" },
  ];
  for (const seed of seeds) {
    const hashtagId = await upsertHashtag(db, seed.tag, now);
    await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: GLOBAL_MARKET, tier: seed.tier, source: "SEED" });
  }
}

async function countByStatus(db: TestDatabase, table: typeof providerJobs | typeof collectionRuns): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: table.status, count: sql<string>`count(*)` })
    .from(table as typeof providerJobs)
    .groupBy(table.status);
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

/** How often (in ticks) the simulation runs analytics — every 4h at the
 * default 30 min tick cadence. Analytics doesn't need to run every tick
 * (brief §59); a periodic cadence here mirrors a realistic deployment
 * without needing a real scheduler. */
const ANALYTICS_EVERY_N_TICKS = 8;

export async function runSimulation(options: SimulationOptions = {}): Promise<SimulationSummary> {
  // 5 days (not just the minimum 3 — brief §38 says "at least") gives
  // Phase 6's EXPLORATION_DEMOTION 4-day evidence window (config/
  // lifecycle.ts) room to genuinely complete within this run.
  const days = options.days ?? 5;
  const tickIntervalMinutes = options.tickIntervalMinutes ?? 30;
  const totalTicks = Math.round((days * 24 * 60) / tickIntervalMinutes);

  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  const clock = new FixedClock(options.startAt ?? new Date("2026-09-12T20:00:00.000Z"));
  await seedSimulationTaxonomy(db, clock.now());

  const apifyFixture = new FixtureProvider({ clock, jobs: buildApifyDiscoveryPlans() });
  const brightdataFixture = new FixtureProvider({ clock, jobs: buildBrightDataFallbackPlans() });
  const providers: Partial<Record<RuntimeProviderId, SocialDataProvider>> = {
    apify: wrapFixtureAsProvider("apify", apifyFixture),
    brightdata: wrapFixtureAsProvider("brightdata", brightdataFixture),
  };
  const registry = new ProviderRegistry(providers, DEFAULT_REGISTRY_CONFIG);
  const circuitBreaker = new CircuitBreaker(new DbCircuitBreakerStore(db), clock);
  const quotaTracker = new ProviderQuotaTracker(new DbProviderQuotaStore(db), clock);

  function buildTickContext(): TickContext {
    return {
      db,
      providers: registry,
      circuitBreaker,
      quotaTracker,
      clock,
      // A fresh Deadline per tick, generous enough never to trip in this
      // offline simulation — mirrors jobs/build-context.ts's real
      // per-invocation construction, just with a larger budget since
      // there's no Vercel wall-clock limit here.
      deadline: new Deadline(10 * 60_000, clock),
      market: GLOBAL_MARKET,
      budgetProfile: "STANDARD",
    };
  }

  const tickResults: TickResult[] = [];
  let replaySummary: SimulationSummary["replay"] = { jobsBeforeReplay: 0, jobsAfterReplay: 0, noDuplicatesCreated: true };
  // Captured ~24h before the run ends (48 ticks at the default 30 min
  // cadence) — a second DailyReport generated here, before the final one,
  // is what gives the final report a real previous-day row to compare
  // against (brief §66).
  const yesterdaySnapshotTick = totalTicks - Math.round((24 * 60) / tickIntervalMinutes);
  let yesterdaySnapshot: Date | null = null;
  const analyticsTotals: AnalyticsStats & { runs: number } = {
    runs: 0,
    postsAnalyzed: 0,
    postsScored: 0,
    baselinesUpdated: 0,
    hashtagsUpdated: 0,
    cooccurrencesUpdated: 0,
    tierPromotions: 0,
    tierDemotions: 0,
    refreshPlansUpdated: 0,
  };

  for (let tick = 0; tick < totalTicks; tick++) {
    const result = await runTick(buildTickContext());
    tickResults.push(result);

    if (tick === yesterdaySnapshotTick) {
      yesterdaySnapshot = new Date(clock.now().getTime());
    }

    // Replay of at least one tick (brief §38): re-run the SAME tick at the
    // SAME simulated instant, without advancing the clock, and confirm it
    // creates no duplicate provider_jobs.
    if (tick === 20) {
      const beforeRows = await db.select({ count: sql<string>`count(*)` }).from(providerJobs);
      const before = Number(beforeRows[0]?.count ?? "0");
      await runTick(buildTickContext());
      const afterRows = await db.select({ count: sql<string>`count(*)` }).from(providerJobs);
      const after = Number(afterRows[0]?.count ?? "0");
      replaySummary = { jobsBeforeReplay: before, jobsAfterReplay: after, noDuplicatesCreated: before === after };
    }

    // Phase 6: run analytics periodically on the same simulated clock —
    // isolated from tick failures/state (run-analytics.ts's own try/catch
    // around every call means a bug here can never corrupt collection
    // state, matching brief §60).
    if (tick % ANALYTICS_EVERY_N_TICKS === 0) {
      const analyticsResult = await runAnalytics({ db, clock, market: GLOBAL_MARKET });
      analyticsTotals.runs += 1;
      analyticsTotals.postsAnalyzed += analyticsResult.postsAnalyzed;
      analyticsTotals.postsScored += analyticsResult.postsScored;
      analyticsTotals.baselinesUpdated += analyticsResult.baselinesUpdated;
      analyticsTotals.hashtagsUpdated += analyticsResult.hashtagsUpdated;
      analyticsTotals.cooccurrencesUpdated += analyticsResult.cooccurrencesUpdated;
      analyticsTotals.tierPromotions += analyticsResult.tierPromotions;
      analyticsTotals.tierDemotions += analyticsResult.tierDemotions;
      analyticsTotals.refreshPlansUpdated += analyticsResult.refreshPlansUpdated;
    }

    clock.advanceMs(tickIntervalMinutes * 60_000);
  }

  async function countAll(rows: Promise<{ count: string }[]>): Promise<number> {
    const result = await rows;
    return Number(result[0]?.count ?? "0");
  }

  const postsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(posts));
  const hashtagsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(hashtags));
  const snapshotsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(postSnapshots));
  const refreshSnapshotsCount = await countAll(
    db.select({ count: sql<string>`count(*)` }).from(postSnapshots).where(eq(postSnapshots.source, "REFRESH")),
  );
  const quarantineCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(quarantinedItems));
  const runsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(collectionRuns));
  const jobsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(providerJobs));
  const hashtagDailyStatsCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(hashtagDailyStats));
  const cooccurrenceCount = await countAll(db.select({ count: sql<string>`count(*)` }).from(hashtagCooccurrenceDaily));

  const runsByStatus = await countByStatus(db, collectionRuns);
  const jobsByStatus = await countByStatus(db, providerJobs);

  const delayedJobRows = await db
    .select({ submittedAt: providerJobs.submittedAt, completedAt: providerJobs.completedAt })
    .from(providerJobs)
    .where(eq(providerJobs.status, "INGESTED"));
  // The deliberately-delayed job (index 1 in buildApifyDiscoveryPlans)
  // needs 2 polls, i.e. at least 2 tick cycles (~60 min at the default
  // 30 min cadence) between submission and completion — comfortably more
  // than a same-tick completion (0), so this threshold cleanly
  // distinguishes "took multiple ticks" from "finished immediately".
  const MULTI_TICK_THRESHOLD_MS = 45 * 60_000;
  const delayedJobCompletedAcrossTicks = delayedJobRows.some(
    (r) => r.submittedAt && r.completedAt && r.completedAt.getTime() - r.submittedAt.getTime() >= MULTI_TICK_THRESHOLD_MS,
  );

  // Phase 7: generate the "yesterday" report first (if the run was long
  // enough to capture a snapshot 24h before the end), then the real final
  // report — entirely offline, same PGlite instance, no provider calls.
  let reportSummary: SimulationSummary["report"] = {
    generated: false,
    status: null,
    todayTopCount: 0,
    stillHotCount: 0,
    risingNowCount: 0,
    hasYesterdayComparison: false,
    clustersCount: 0,
    exportsValid: false,
  };
  let retentionRanCleanly = false;
  try {
    if (yesterdaySnapshot) {
      await generateDailyReport({ db, clock: new FixedClock(yesterdaySnapshot), market: GLOBAL_MARKET, timezone: "UTC" });
    }
    const finalResult = await generateDailyReport({ db, clock, market: GLOBAL_MARKET, timezone: "UTC" });
    const finalReport = await getDailyReport(db, finalResult.reportDate, GLOBAL_MARKET);
    if (finalReport) {
      const json = exportJson(finalReport);
      const csv = exportCsv(finalReport);
      const md = exportMarkdown(finalReport);
      const exportsValid = (() => {
        try {
          JSON.parse(json);
          return csv.charCodeAt(0) === 0xfeff && md.includes("Today Top");
        } catch {
          return false;
        }
      })();
      reportSummary = {
        generated: true,
        status: finalReport.status,
        todayTopCount: finalReport.todayTop.length,
        stillHotCount: finalReport.stillHot.length,
        risingNowCount: finalReport.risingNow.length,
        hasYesterdayComparison: finalReport.comparisons.vsYesterday !== null,
        clustersCount: finalReport.clusters.length,
        exportsValid,
      };
    }

    const retentionResult = await runRetention({ db, clock, dryRun: false });
    retentionRanCleanly = retentionResult.dryRun === false;
  } catch {
    // A report/retention failure must never be mistaken for a tick-
    // pipeline failure (brief §60) — the summary's own flags above stay
    // at their safe "not generated"/"did not run" defaults instead of
    // throwing out of the whole simulation.
  }

  await client.close();

  return {
    ticks: totalTicks,
    collectionRuns: Number(runsCount),
    runsByStatus,
    providerJobsCreated: Number(jobsCount),
    jobsByStatus,
    postsPersisted: Number(postsCount),
    distinctHashtagsTracked: Number(hashtagsCount),
    snapshotsTotal: Number(snapshotsCount),
    refreshSnapshots: Number(refreshSnapshotsCount),
    quarantinedItemCount: Number(quarantineCount),
    partialRunOccurred: (runsByStatus.PARTIAL ?? 0) > 0,
    delayedJobCompletedAcrossTicks,
    replay: replaySummary,
    offlineOnly: true,
    analyticsRuns: analyticsTotals.runs,
    postsScored: analyticsTotals.postsScored,
    hashtagDailyStatsRows: Number(hashtagDailyStatsCount),
    cooccurrenceRows: Number(cooccurrenceCount),
    tierPromotions: analyticsTotals.tierPromotions,
    tierDemotions: analyticsTotals.tierDemotions,
    refreshPlansUpdated: analyticsTotals.refreshPlansUpdated,
    report: reportSummary,
    retentionRanCleanly,
  };
}
