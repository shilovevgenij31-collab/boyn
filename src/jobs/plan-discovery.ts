/**
 * Discovery planning (Phase 5 brief §8-13, §16-18): for each platform,
 * find/create the current discovery slot's collection_run (idempotent on
 * slot_key), select due tracked hashtags, and — if a provider is
 * available and budget allows — persist a PENDING provider_jobs row
 * before any paid call is made (see provider-jobs.ts's module comment for
 * why that ordering matters for crash recovery).
 */
import { PLATFORMS, type Platform } from "@/core/domain/platform.ts";
import { computeSlotStart, buildSlotKey } from "@/core/scheduling/slot.ts";
import { selectHashtagsForDiscovery } from "@/core/scheduling/tag-selector.ts";
import {
  DISCOVERY_BATCH_SIZE_PER_JOB,
  DISCOVERY_SLOT_ALLOCATION,
  DISCOVERY_SLOT_HOURS_UTC,
  MAX_JOB_ATTEMPTS_PER_RUN,
  POSTS_PER_DISCOVERY_QUERY,
} from "@/config/schedule.ts";
import { createCollectionRun, finalizeCollectionRun, startCollectionRun } from "@/db/repositories/runs.ts";
import { getDueTrackedHashtagsByTier } from "@/db/repositories/tracking.ts";
import { getJobsForCollectionRun, planProviderJob } from "@/db/repositories/provider-jobs.ts";
import { getBudgetStatus, canSubmitToProvider } from "@/providers/budget.ts";
import { isProviderError } from "@/providers/errors.ts";
import { isProviderId } from "@/core/domain/provider.ts";
import type { TickContext, DiscoveryJobPersistedInput, PartialReason } from "./types.ts";

const HEADROOM = 3;

export interface PlanDiscoveryResult {
  runsConsidered: number;
  jobsPlanned: number;
  partialReasons: PartialReason[];
}

export async function planDiscovery(ctx: TickContext): Promise<PlanDiscoveryResult> {
  const result: PlanDiscoveryResult = { runsConsidered: 0, jobsPlanned: 0, partialReasons: [] };

  for (const platform of PLATFORMS) {
    if (ctx.deadline.isExpired()) {
      result.partialReasons.push("DEADLINE");
      break;
    }
    const outcome = await planDiscoveryForPlatform(ctx, platform);
    result.runsConsidered += 1;
    result.jobsPlanned += outcome.jobPlanned ? 1 : 0;
    if (outcome.partialReason) result.partialReasons.push(outcome.partialReason);
  }

  return result;
}

async function planDiscoveryForPlatform(
  ctx: TickContext,
  platform: Platform,
): Promise<{ jobPlanned: boolean; partialReason?: PartialReason }> {
  const now = ctx.clock.now();
  const slotStart = computeSlotStart(now, DISCOVERY_SLOT_HOURS_UTC);
  const slotKey = buildSlotKey("discovery", platform, ctx.market, slotStart);

  const run = await createCollectionRun(ctx.db, {
    kind: "DISCOVERY",
    slotKey,
    plannedAt: slotStart,
    triggeredBy: "tick",
  });

  const existingJobs = await getJobsForCollectionRun(ctx.db, run.id);
  if (existingJobs.length > 0) {
    const allFailed = existingJobs.every((j) => j.status === "FAILED" || j.status === "TIMED_OUT");
    if (!allFailed || existingJobs.length >= MAX_JOB_ATTEMPTS_PER_RUN) {
      // Already planned and either still in flight, already succeeded, or
      // has exhausted its retry budget — idempotent no-op either way.
      return { jobPlanned: false };
    }
    // Every attempt so far failed outright and there's budget for one
    // more — re-plan into the SAME run (e.g. a fresh resolveAvailable()
    // call may now route to a fallback provider), which is what makes
    // this run's eventual status genuinely PARTIAL rather than FAILED.
  }

  const perTier = Math.ceil(DISCOVERY_BATCH_SIZE_PER_JOB / 2) + HEADROOM;
  const [core, active, explorationOrDormant] = await Promise.all([
    getDueTrackedHashtagsByTier(ctx.db, platform, ctx.market, ["CORE"], now, DISCOVERY_SLOT_ALLOCATION.core + HEADROOM),
    getDueTrackedHashtagsByTier(ctx.db, platform, ctx.market, ["ACTIVE"], now, DISCOVERY_SLOT_ALLOCATION.active + HEADROOM),
    getDueTrackedHashtagsByTier(
      ctx.db,
      platform,
      ctx.market,
      ["EXPLORATION", "DORMANT"],
      now,
      DISCOVERY_SLOT_ALLOCATION.explorationOrDormant + perTier,
    ),
  ]);

  const selected = selectHashtagsForDiscovery({ core, active, explorationOrDormant }, DISCOVERY_BATCH_SIZE_PER_JOB);
  if (selected.length === 0) {
    await finalizeCollectionRun(ctx.db, run.id, { status: "SKIPPED", now, recordsUsed: 0 });
    return { jobPlanned: false };
  }

  let provider;
  try {
    provider = await ctx.providers.resolveAvailable(platform, "DISCOVERY", ctx.circuitBreaker, ctx.quotaTracker);
  } catch (error) {
    if (isProviderError(error)) {
      await finalizeCollectionRun(ctx.db, run.id, {
        status: "SKIPPED",
        now,
        recordsUsed: 0,
        errorSummary: error.message,
      });
      return { jobPlanned: false, partialReason: "PROVIDER_UNAVAILABLE" };
    }
    throw error;
  }

  if (!isProviderId(provider.id)) {
    // "fixture" only ever appears in the registry in tests/simulation,
    // wrapped so its `id` reads as a real ProviderId there too — see
    // scripts/simulate.ts. This is an invariant guard, not a real path.
    throw new Error(`planDiscovery: resolved a non-persistable provider id "${provider.id}"`);
  }

  const budgetStatus = await getBudgetStatus(ctx.db, now, ctx.budgetProfile);
  if (!canSubmitToProvider(budgetStatus, provider.id)) {
    await finalizeCollectionRun(ctx.db, run.id, {
      status: "SKIPPED",
      now,
      recordsUsed: 0,
      errorSummary: "budget exhausted at planning time",
    });
    return { jobPlanned: false, partialReason: "BUDGET_EXHAUSTED" };
  }

  const input: DiscoveryJobPersistedInput = {
    queries: selected.map((c) => ({
      query: c.hashtagName,
      hashtagId: c.hashtagId,
      trackedHashtagId: c.trackedHashtagId,
      tier: c.tier,
      source: c.source,
      trendState: c.trendState,
    })),
    limitPerQuery: POSTS_PER_DISCOVERY_QUERY,
  };

  await planProviderJob(ctx.db, {
    collectionRunId: run.id,
    provider: provider.id,
    platform,
    jobType: "HASHTAG_DISCOVERY",
    input: input as unknown as Record<string, unknown>,
  });
  await startCollectionRun(ctx.db, run.id, now);

  return { jobPlanned: true };
}
