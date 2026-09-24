/**
 * Submit phase (Phase 5 brief §13-19): for each PENDING job (durable
 * intent already persisted by the plan phase), acquire a lease, re-verify
 * budget/circuit (state may have changed since planning — e.g. an earlier
 * job in this same tick just tripped the circuit), then make the actual
 * paid provider call and record the outcome.
 */
import { randomUUID } from "node:crypto";
import {
  acquireSubmitLease,
  getPendingJobIds,
  getProviderJobById,
  markJobSubmitFailed,
  markJobSubmitted,
  releaseSubmitLeaseWithoutAttempt,
  type JobType,
} from "@/db/repositories/provider-jobs.ts";
import { recordErrorEvent } from "@/db/repositories/error-events.ts";
import { getBudgetStatus, canSubmitToProvider } from "@/providers/budget.ts";
import { isCircuitEligibleFailure, isProviderError } from "@/providers/errors.ts";
import type { CircuitKey, ProviderOperation } from "@/providers/circuit-breaker.ts";
import { JOB_LEASE_MS, POLL_INTERVAL_MS, TICK_LIMITS } from "@/config/schedule.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { Market } from "@/core/domain/market.ts";
import type { DiscoveryJobPersistedInput, PartialReason, RefreshJobPersistedInput, TickContext } from "./types.ts";

export interface SubmitJobsResult {
  submitted: number;
  failed: number;
  partialReasons: PartialReason[];
}

function jobTypeToOperation(jobType: JobType): ProviderOperation {
  return jobType === "HASHTAG_DISCOVERY" ? "DISCOVERY" : "REFRESH";
}

export async function submitPendingJobs(ctx: TickContext): Promise<SubmitJobsResult> {
  const result: SubmitJobsResult = { submitted: 0, failed: 0, partialReasons: [] };
  const now0 = ctx.clock.now();
  const pendingIds = await getPendingJobIds(ctx.db, now0, TICK_LIMITS.maxSubmissions);

  for (const id of pendingIds) {
    if (ctx.deadline.isExpired()) {
      result.partialReasons.push("DEADLINE");
      break;
    }

    const now = ctx.clock.now();
    const leased = await acquireSubmitLease(ctx.db, id, now, new Date(now.getTime() + JOB_LEASE_MS));
    if (!leased) continue; // another worker/tick won the race

    const row = await getProviderJobById(ctx.db, id);
    if (!row) {
      await releaseSubmitLeaseWithoutAttempt(ctx.db, id);
      continue;
    }

    const circuitKey: CircuitKey = { provider: row.provider, platform: row.platform, operation: jobTypeToOperation(row.jobType) };

    const circuitAvailable = await ctx.circuitBreaker.isAvailable(circuitKey);
    if (!circuitAvailable) {
      // This row's provider is fixed at plan time. Its circuit opening
      // since then means retrying THIS row against the same provider is
      // pointless — mark it FAILED so it stops being retried; the due
      // tags/posts it was for remain due and get replanned (possibly with
      // fallback) by a later planning pass, since they were never marked
      // scanned/refreshed.
      await markJobSubmitFailed(ctx.db, id, "provider circuit open at submit time", now);
      result.failed += 1;
      result.partialReasons.push("PROVIDER_UNAVAILABLE");
      continue;
    }

    const budgetStatus = await getBudgetStatus(ctx.db, now, ctx.budgetProfile);
    if (!canSubmitToProvider(budgetStatus, row.provider)) {
      // Budget denial is not a provider failure (§16) — leave PENDING for
      // a later tick once budget/profile conditions change.
      await releaseSubmitLeaseWithoutAttempt(ctx.db, id);
      result.partialReasons.push("BUDGET_EXHAUSTED");
      continue;
    }

    try {
      const provider = ctx.providers.getById(row.provider);
      const httpStart = now.getTime();

      const submitted =
        row.jobType === "HASHTAG_DISCOVERY"
          ? await provider.submitDiscovery(buildDiscoveryInput(row.platform, row.input as unknown as DiscoveryJobPersistedInput, ctx.market))
          : await provider.submitRefresh(buildRefreshInput(row.platform, row.input as unknown as RefreshJobPersistedInput));

      const httpMs = ctx.clock.now().getTime() - httpStart;
      const pollIntervalMs = POLL_INTERVAL_MS[row.provider];
      await markJobSubmitted(ctx.db, id, {
        externalJobId: submitted.externalJobId,
        submittedAt: submitted.submittedAt,
        httpMs,
        status: "SUBMITTED",
        nextPollAt: new Date(submitted.submittedAt.getTime() + pollIntervalMs),
        webhookToken: randomUUID(),
      });
      await ctx.circuitBreaker.recordSuccess(circuitKey);
      result.submitted += 1;
    } catch (error) {
      if (isCircuitEligibleFailure(error)) {
        await ctx.circuitBreaker.recordFailure(circuitKey, error);
      }
      if (isProviderError(error) && error.code === "QUOTA") {
        // Production incident (Phase 8/9 hotfix Part C): QUOTA doesn't
        // trip the circuit breaker (isCircuitEligibleFailure excludes it
        // deliberately — it's an account condition, not an outage), but
        // routing still needs to know this provider is unusable right
        // now so the next planning pass can fall back — see
        // registry.ts's resolveAvailable + quota-tracker.ts.
        await ctx.quotaTracker.recordExhausted(row.provider, row.platform, jobTypeToOperation(row.jobType));
      }
      const message = isProviderError(error) ? error.message : error instanceof Error ? error.message : String(error);
      await markJobSubmitFailed(ctx.db, id, message, ctx.clock.now());
      result.failed += 1;
      result.partialReasons.push("PARTIAL_PROVIDER_FAILURE");

      if (!isProviderError(error)) {
        // An unclassified/unexpected failure — not a normal operational
        // condition (§53-54) — gets a durable, non-secret record.
        await recordErrorEvent(ctx.db, {
          at: ctx.clock.now(),
          scope: "jobs.submit",
          severity: "ERROR",
          message,
          context: { jobId: id, provider: row.provider, platform: row.platform, jobType: row.jobType },
        });
      }
    }
  }

  return result;
}

function buildDiscoveryInput(platform: Platform, input: DiscoveryJobPersistedInput, market: Market) {
  return {
    platform,
    market,
    queries: input.queries.map((q) => ({ query: q.query, hashtagId: q.hashtagId })),
    limitPerQuery: input.limitPerQuery,
  };
}

function buildRefreshInput(platform: Platform, input: RefreshJobPersistedInput) {
  return {
    platform,
    posts: input.posts.map((p) => ({ externalId: p.externalId, canonicalUrl: p.canonicalUrl })),
  };
}
