/**
 * Finalize phase (Phase 5 brief §32-34): close out a collection_run only
 * once every provider_job it owns has reached a terminal state. A run can
 * legitimately span many ticks while a slow job is still in flight —
 * this function is the only place that ever marks a run COMPLETED/
 * PARTIAL/FAILED, and it never does so prematurely.
 */
import { finalizeCollectionRun, getOpenCollectionRuns } from "@/db/repositories/runs.ts";
import { getJobsForCollectionRun } from "@/db/repositories/provider-jobs.ts";
import { MAX_JOB_ATTEMPTS_PER_RUN } from "@/config/schedule.ts";
import type { TickContext } from "./types.ts";

const MAX_OPEN_RUNS_PER_TICK = 25;
const TERMINAL_STATUSES = new Set(["INGESTED", "FAILED", "TIMED_OUT"]);
const FAILURE_STATUSES = new Set(["FAILED", "TIMED_OUT"]);

export interface FinalizeRunsResult {
  finalized: number;
}

export async function finalizeRuns(ctx: TickContext): Promise<FinalizeRunsResult> {
  const result: FinalizeRunsResult = { finalized: 0 };
  const now = ctx.clock.now();
  const openRuns = await getOpenCollectionRuns(ctx.db, MAX_OPEN_RUNS_PER_TICK);

  for (const run of openRuns) {
    if (ctx.deadline.isExpired()) break;

    const jobs = await getJobsForCollectionRun(ctx.db, run.id);
    if (jobs.length === 0) continue; // still PLANNED, no job persisted yet

    const allTerminal = jobs.every((j) => TERMINAL_STATUSES.has(j.status));
    if (!allTerminal) continue;

    const allFailedSoFar = jobs.every((j) => FAILURE_STATUSES.has(j.status));
    if (allFailedSoFar && jobs.length < MAX_JOB_ATTEMPTS_PER_RUN) {
      // Leave the run open — plan-discovery/plan-refresh get one more
      // chance (possibly via a fallback provider) before this counts as
      // a genuine dead end (Phase 5 brief §32-34/§39: an injected failure
      // should be able to resolve into a real PARTIAL run, not just FAILED).
      continue;
    }

    const ingestedCount = jobs.filter((j) => j.status === "INGESTED").length;
    const status = ingestedCount === jobs.length ? "COMPLETED" : ingestedCount > 0 ? "PARTIAL" : "FAILED";

    await finalizeCollectionRun(ctx.db, run.id, {
      status,
      now,
      stats: { jobs: jobs.length, ingested: ingestedCount, failed: jobs.length - ingestedCount },
    });
    result.finalized += 1;
  }

  return result;
}
