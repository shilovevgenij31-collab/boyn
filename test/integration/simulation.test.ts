/**
 * Phase 5 brief §58 (extended by Phase 6 brief §65-66): the offline
 * simulation's underlying engine must be assertable in Vitest, not just
 * runnable as a CLI script that prints a summary. Asserts the same
 * invariants scripts/simulate.ts checks (brief §39, §66).
 */
import { describe, expect, it } from "vitest";
import { runSimulation } from "../../scripts/simulation/engine.ts";

// Two full 5-day simulations (tick pipeline + periodic analytics) each
// take well over the project's default 30s test timeout — genuinely
// slow, not stuck.
const SIMULATION_TEST_TIMEOUT_MS = 90_000;

describe("offline multi-day simulation (tick pipeline + analytics)", () => {
  it(
    "runs several simulated days entirely offline and produces internally consistent, non-trivial state",
    async () => {
      const summary = await runSimulation();

      expect(summary.offlineOnly).toBe(true);
      expect(summary.ticks).toBe(240); // 5 days * 24h * 2 ticks/hour at the default 30 min cadence

      // Collection runs and provider jobs were actually created.
      expect(summary.collectionRuns).toBeGreaterThan(0);
      expect(summary.providerJobsCreated).toBeGreaterThan(0);

      // Real data was persisted, and every post has at least one snapshot.
      expect(summary.postsPersisted).toBeGreaterThan(0);
      expect(summary.snapshotsTotal).toBeGreaterThanOrEqual(summary.postsPersisted);

      // Hashtags stay deduplicated: the same fixture items get
      // re-discovered many times over 5 days (the same small provider
      // queue cycles repeatedly), each carrying several caption hashtags —
      // `upsertHashtag`'s unique constraint on `name` means re-discovery
      // never creates a duplicate row, only updates last_seen_at. The count
      // includes both the 5 seeded tracked tags and every distinct tag
      // actually present in the fixtures' captions, so it's well above 5
      // but must stay bounded rather than growing with every re-discovery.
      expect(summary.distinctHashtagsTracked).toBeGreaterThanOrEqual(5);
      expect(summary.distinctHashtagsTracked).toBeLessThan(100);

      // At least one refresh occurred (a REFRESH-sourced snapshot exists).
      expect(summary.refreshSnapshots).toBeGreaterThan(0);

      // The injected provider failure (brief §38) resolved into a genuine
      // PARTIAL run once the same-run retry succeeded.
      expect(summary.partialRunOccurred).toBe(true);
      expect(summary.runsByStatus.PARTIAL).toBeGreaterThan(0);

      // The deliberately delayed job completed on a later tick, not the
      // same one it was submitted on.
      expect(summary.delayedJobCompletedAcrossTicks).toBe(true);

      // Replaying a tick at the same simulated instant created no
      // duplicate provider_jobs.
      expect(summary.replay.noDuplicatesCreated).toBe(true);
      expect(summary.replay.jobsBeforeReplay).toBe(summary.replay.jobsAfterReplay);

      // No malformed items in this run (all fixture items are real,
      // schema-valid captures) — a nonzero count would still be a valid
      // outcome in general (§24), just not expected with this fixture set.
      expect(summary.quarantinedItemCount).toBe(0);

      // Phase 6: analytics actually ran and scored real posts, produced
      // hashtag daily stats and co-occurrence rows.
      expect(summary.analyticsRuns).toBeGreaterThan(0);
      expect(summary.postsScored).toBeGreaterThan(0);
      expect(summary.hashtagDailyStatsRows).toBeGreaterThan(0);
      expect(summary.cooccurrenceRows).toBeGreaterThan(0);

      // At least one genuine EXPLORATION -> ACTIVE promotion (the boosted
      // #pcgaming posts from two distinct authors) and at least one
      // demotion (the seeded ACTIVE "streamer" tag, which never receives a
      // single qualifying post over the run) — both caused by real
      // evidence flowing through core/lifecycle/hashtag-lifecycle.ts, never
      // a hard-coded tier mutation (brief §66).
      expect(summary.tierPromotions).toBeGreaterThan(0);
      expect(summary.tierDemotions).toBeGreaterThan(0);

      // Phase 7 (brief §66): a real DailyReport was generated at the end
      // of the run, with a genuine vsYesterday comparison (a second report
      // was generated ~24h earlier in the same run so this isn't the
      // first-ever report for its market), and every export format is
      // valid — all entirely offline, plus a final retention sweep that
      // completes without destroying the state the run just produced.
      expect(summary.report.generated).toBe(true);
      expect(summary.report.status).not.toBeNull();
      expect(summary.report.hasYesterdayComparison).toBe(true);
      expect(summary.report.exportsValid).toBe(true);
      expect(summary.retentionRanCleanly).toBe(true);
    },
    SIMULATION_TEST_TIMEOUT_MS,
  );

  it(
    "is deterministic: two independent runs with the same options produce the same shape of outcome",
    async () => {
      const first = await runSimulation();
      const second = await runSimulation();

      expect(second.ticks).toBe(first.ticks);
      expect(second.collectionRuns).toBe(first.collectionRuns);
      expect(second.providerJobsCreated).toBe(first.providerJobsCreated);
      expect(second.postsPersisted).toBe(first.postsPersisted);
      expect(second.partialRunOccurred).toBe(first.partialRunOccurred);
      expect(second.delayedJobCompletedAcrossTicks).toBe(first.delayedJobCompletedAcrossTicks);
      expect(second.tierPromotions).toBe(first.tierPromotions);
      expect(second.tierDemotions).toBe(first.tierDemotions);
    },
    SIMULATION_TEST_TIMEOUT_MS,
  );
});
