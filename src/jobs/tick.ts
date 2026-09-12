/**
 * The single tick entry point (Phase 5 brief §3, §46): reconcile existing
 * work first, only then plan/submit new work, so older unfinished jobs
 * never starve because a tick keeps planning fresh work ahead of them.
 * Framework-independent — the Next.js cron route (src/app/api/cron/tick)
 * is a thin adapter around this.
 *
 * Phase order: poll -> ingest -> finalize -> plan -> submit -> finalize.
 * The final finalize catches runs whose only job just got submitted and
 * (in a fast offline simulation) could already be terminal within the
 * same tick.
 */
import { getBudgetStatus } from "@/providers/budget.ts";
import { isCollectionPaused } from "@/db/repositories/settings.ts";
import { pollJobs } from "./poll-jobs.ts";
import { ingestReadyJobs } from "./ingest-job.ts";
import { finalizeRuns } from "./finalize-runs.ts";
import { planDiscovery } from "./plan-discovery.ts";
import { planRefresh } from "./plan-refresh.ts";
import { submitPendingJobs } from "./submit-jobs.ts";
import type { PartialReason, TickContext, TickResult } from "./types.ts";

export async function runTick(ctx: TickContext): Promise<TickResult> {
  const startedAt = ctx.clock.now();
  const partialReasons: PartialReason[] = [];

  const pollResult = await pollJobs(ctx);
  partialReasons.push(...pollResult.partialReasons);

  const ingestResult = await ingestReadyJobs(ctx);
  partialReasons.push(...ingestResult.partialReasons);

  await finalizeRuns(ctx);

  let discoveryRuns = 0;
  let refreshRuns = 0;
  let jobsPlanned = 0;
  let submittedCount = 0;
  let submitFailedCount = 0;

  if (ctx.deadline.isExpired()) {
    partialReasons.push("DEADLINE");
  } else if (await isCollectionPaused(ctx.db)) {
    partialReasons.push("COLLECTION_PAUSED");
  } else {
    const discoveryResult = await planDiscovery(ctx);
    discoveryRuns = discoveryResult.runsConsidered;
    jobsPlanned += discoveryResult.jobsPlanned;
    partialReasons.push(...discoveryResult.partialReasons);

    const refreshResult = await planRefresh(ctx);
    refreshRuns = 1;
    jobsPlanned += refreshResult.jobPlanned ? 1 : 0;
    if (refreshResult.partialReason) partialReasons.push(refreshResult.partialReason);

    if (!ctx.deadline.isExpired()) {
      const submitResult = await submitPendingJobs(ctx);
      submittedCount = submitResult.submitted;
      submitFailedCount = submitResult.failed;
      partialReasons.push(...submitResult.partialReasons);
    } else {
      partialReasons.push("DEADLINE");
    }
  }

  await finalizeRuns(ctx);

  const budgetStatus = await getBudgetStatus(ctx.db, ctx.clock.now(), ctx.budgetProfile);
  const finishedAt = ctx.clock.now();

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    planned: { discoveryRuns, refreshRuns, jobsPlanned },
    submitted: submittedCount,
    polled: pollResult.polled,
    ingested: ingestResult.ingested,
    failed: submitFailedCount + pollResult.failed + ingestResult.failed,
    skipped: 0,
    budget: {
      usedToday: budgetStatus.usedToday,
      usedThisMonth: budgetStatus.usedThisMonth,
      monthlyUsdExceeded: budgetStatus.monthlyUsdExceeded,
    },
    partialReasons: dedupe(partialReasons),
  };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
