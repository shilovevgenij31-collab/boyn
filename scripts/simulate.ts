/**
 * CLI entry point for the offline multi-day simulation (Phase 5 brief
 * §38, extended for Phase 6 brief §65-66). Fully offline: PGlite +
 * FixtureProvider + an injected FixedClock, no network calls, no
 * secrets. Run via:
 *
 *   npx tsx scripts/simulate.ts
 *   npm run simulate
 *
 * The reusable engine (importable from tests too — brief §58) lives in
 * scripts/simulation/engine.ts.
 */
import { runSimulation } from "./simulation/engine.ts";

async function main(): Promise<void> {
  console.log("[simulate] running a multi-day offline tick + analytics simulation (no network, no secrets)...");
  const summary = await runSimulation();
  console.log("[simulate] done.\n");
  console.log(JSON.stringify(summary, null, 2));

  const invariantFailures: string[] = [];
  if (summary.collectionRuns === 0) invariantFailures.push("no collection_runs were created");
  if (summary.providerJobsCreated === 0) invariantFailures.push("no provider_jobs were created");
  if (summary.postsPersisted === 0) invariantFailures.push("no posts were persisted");
  if (summary.snapshotsTotal < summary.postsPersisted) invariantFailures.push("fewer snapshots than posts");
  if (!summary.partialRunOccurred) invariantFailures.push("the injected failure never produced a PARTIAL run");
  if (!summary.delayedJobCompletedAcrossTicks) invariantFailures.push("the delayed job never completed across multiple ticks");
  if (!summary.replay.noDuplicatesCreated) invariantFailures.push("replaying a tick created duplicate provider_jobs");
  if (summary.refreshSnapshots === 0) invariantFailures.push("no refresh ever occurred");
  if (summary.postsScored === 0) invariantFailures.push("no posts were ever scored by analytics");
  if (summary.hashtagDailyStatsRows === 0) invariantFailures.push("no hashtag_daily_stats rows were produced");
  if (summary.cooccurrenceRows === 0) invariantFailures.push("no co-occurrence rows were produced");
  if (summary.tierPromotions === 0) invariantFailures.push("no lifecycle tier promotion ever happened");
  if (summary.tierDemotions === 0) invariantFailures.push("no lifecycle tier demotion ever happened");
  if (!summary.report.generated) invariantFailures.push("no DailyReport was ever generated");
  if (!summary.report.hasYesterdayComparison) invariantFailures.push("the final DailyReport has no vsYesterday comparison");
  if (!summary.report.exportsValid) invariantFailures.push("Markdown/CSV/JSON export of the final report failed validation");
  if (!summary.retentionRanCleanly) invariantFailures.push("the final retention sweep did not run cleanly");

  if (invariantFailures.length > 0) {
    console.error("\n[simulate] FAILED invariants:");
    for (const failure of invariantFailures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n[simulate] all invariants held.");
}

main().catch((error) => {
  console.error("[simulate] FATAL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
