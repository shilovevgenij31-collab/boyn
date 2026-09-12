/**
 * Phase 5 brief §58: the 3-day offline simulation's underlying engine
 * must be assertable in Vitest, not just runnable as a CLI script that
 * prints a summary. Asserts the same invariants scripts/simulate.ts
 * checks (brief §39).
 */
import { describe, expect, it } from "vitest";
import { runSimulation } from "../../scripts/simulation/engine.ts";

describe("Phase 5 offline 3-day simulation", () => {
  it("runs 3 simulated days entirely offline and produces internally consistent, non-trivial state", async () => {
    const summary = await runSimulation();

    expect(summary.offlineOnly).toBe(true);
    expect(summary.ticks).toBe(144); // 3 days * 24h * 2 ticks/hour at the default 30 min cadence

    // Collection runs and provider jobs were actually created.
    expect(summary.collectionRuns).toBeGreaterThan(0);
    expect(summary.providerJobsCreated).toBeGreaterThan(0);

    // Real data was persisted, and every post has at least one snapshot.
    expect(summary.postsPersisted).toBeGreaterThan(0);
    expect(summary.snapshotsTotal).toBeGreaterThanOrEqual(summary.postsPersisted);

    // Hashtags stay deduplicated: the same 5 real fixture items get
    // re-discovered many times over 3 days (the same small provider
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
  });

  it("is deterministic: two independent runs with the same options produce the same shape of outcome", async () => {
    const first = await runSimulation();
    const second = await runSimulation();

    expect(second.ticks).toBe(first.ticks);
    expect(second.collectionRuns).toBe(first.collectionRuns);
    expect(second.providerJobsCreated).toBe(first.providerJobsCreated);
    expect(second.postsPersisted).toBe(first.postsPersisted);
    expect(second.partialRunOccurred).toBe(first.partialRunOccurred);
    expect(second.delayedJobCompletedAcrossTicks).toBe(first.delayedJobCompletedAcrossTicks);
  });
});
