/**
 * Poll phase (Phase 5 brief §20-22): check status for jobs already
 * submitted, whose next_poll_at is due. Never waits synchronously for a
 * provider — one status check per job per call, exactly like production
 * Apify/Bright Data adapters already behave (Phase 4).
 */
import {
  acquirePollLease,
  getPollableJobIds,
  getProviderJobById,
  markJobPolled,
  releaseLease,
  type JobStatus,
} from "@/db/repositories/provider-jobs.ts";
import { recordErrorEvent } from "@/db/repositories/error-events.ts";
import { ProviderError, isCircuitEligibleFailure, isProviderError } from "@/providers/errors.ts";
import type { CircuitKey, ProviderOperation } from "@/providers/circuit-breaker.ts";
import { JOB_LEASE_MS, JOB_MAX_RUNNING_MS, POLL_INTERVAL_MS, TICK_LIMITS } from "@/config/schedule.ts";
import type { PartialReason, TickContext } from "./types.ts";
import type { JobType } from "@/db/repositories/provider-jobs.ts";

export interface PollJobsResult {
  polled: number;
  becameReady: number;
  failed: number;
  partialReasons: PartialReason[];
}

function jobTypeToOperation(jobType: JobType): ProviderOperation {
  return jobType === "HASHTAG_DISCOVERY" ? "DISCOVERY" : "REFRESH";
}

export async function pollJobs(ctx: TickContext): Promise<PollJobsResult> {
  const result: PollJobsResult = { polled: 0, becameReady: 0, failed: 0, partialReasons: [] };
  const now0 = ctx.clock.now();
  const ids = await getPollableJobIds(ctx.db, now0, TICK_LIMITS.maxPolls);

  for (const id of ids) {
    if (ctx.deadline.isExpired()) {
      result.partialReasons.push("DEADLINE");
      break;
    }

    const now = ctx.clock.now();
    const row = await getProviderJobById(ctx.db, id);
    if (!row || (row.status !== "SUBMITTED" && row.status !== "RUNNING") || !row.externalJobId || !row.submittedAt) {
      continue;
    }

    const leased = await acquirePollLease(ctx.db, id, row.status, now, new Date(now.getTime() + JOB_LEASE_MS));
    if (!leased) continue;

    const circuitKey: CircuitKey = { provider: row.provider, platform: row.platform, operation: jobTypeToOperation(row.jobType) };

    const ageMs = now.getTime() - row.submittedAt.getTime();
    if (ageMs > JOB_MAX_RUNNING_MS[row.provider]) {
      await markJobPolled(ctx.db, id, { status: "TIMED_OUT", now, error: `exceeded max running time (${ageMs}ms)` });
      const timeoutError = new ProviderError("TIMEOUT", row.provider, "poll", "job exceeded max running time");
      await ctx.circuitBreaker.recordFailure(circuitKey, timeoutError);
      result.failed += 1;
      result.partialReasons.push("PARTIAL_PROVIDER_FAILURE");
      continue;
    }

    try {
      const provider = ctx.providers.getById(row.provider);
      const status = await provider.getStatus(row.externalJobId);
      result.polled += 1;

      const dbStatus = mapToDbStatus(status.state);
      if (dbStatus === "RUNNING") {
        await markJobPolled(ctx.db, id, { status: "RUNNING", now, nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS[row.provider]) });
      } else if (dbStatus === "READY") {
        await markJobPolled(ctx.db, id, { status: "READY", now });
        await ctx.circuitBreaker.recordSuccess(circuitKey);
        result.becameReady += 1;
      } else {
        await markJobPolled(ctx.db, id, { status: "FAILED", now, error: `vendor reported FAILED (rawVendorStatus=${status.rawVendorStatus})` });
        const vendorFailure = new ProviderError("UPSTREAM", row.provider, "poll", `vendor reported job FAILED (rawVendorStatus=${status.rawVendorStatus})`);
        await ctx.circuitBreaker.recordFailure(circuitKey, vendorFailure);
        result.failed += 1;
        result.partialReasons.push("PARTIAL_PROVIDER_FAILURE");
      }
    } catch (error) {
      // A failure to CHECK status (network/API hiccup) is not the same as
      // the job itself failing — leave status/nextPollAt as-is (retry next
      // tick) and just release the lease, rather than marking a possibly
      // still-healthy job FAILED.
      if (isCircuitEligibleFailure(error)) {
        await ctx.circuitBreaker.recordFailure(circuitKey, error);
      }
      await releaseLease(ctx.db, id);
      result.partialReasons.push("PARTIAL_PROVIDER_FAILURE");

      if (!isProviderError(error)) {
        await recordErrorEvent(ctx.db, {
          at: ctx.clock.now(),
          scope: "jobs.poll",
          severity: "ERROR",
          message: error instanceof Error ? error.message : String(error),
          context: { jobId: id, provider: row.provider, platform: row.platform },
        });
      }
    }
  }

  return result;
}

function mapToDbStatus(state: "SUBMITTED" | "RUNNING" | "READY" | "FAILED"): JobStatus {
  if (state === "READY") return "READY";
  if (state === "FAILED") return "FAILED";
  return "RUNNING";
}
