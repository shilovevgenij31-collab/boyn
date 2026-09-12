/**
 * TikTok refresh planning (Phase 5 brief §28-31). Same idempotent-slot
 * pattern as plan-discovery.ts, restricted to tiktok — Instagram has no
 * refresh provider (Phase 4 ADR-024) and must never get a paid refresh
 * job planned for it.
 */
import { computeSlotStart, buildSlotKey } from "@/core/scheduling/slot.ts";
import { isRefreshDue } from "@/core/scheduling/refresh-planner.ts";
import { MAX_JOB_ATTEMPTS_PER_RUN, REFRESH_MAX_POSTS_PER_RUN, REFRESH_SLOT_HOURS_UTC } from "@/config/schedule.ts";
import { createCollectionRun, finalizeCollectionRun, startCollectionRun } from "@/db/repositories/runs.ts";
import { getRefreshCandidatePosts } from "@/db/repositories/posts.ts";
import { getJobsForCollectionRun, planProviderJob } from "@/db/repositories/provider-jobs.ts";
import { getBudgetStatus, canSubmitToProvider } from "@/providers/budget.ts";
import { isProviderError } from "@/providers/errors.ts";
import { isProviderId } from "@/core/domain/provider.ts";
import type { TickContext, RefreshJobPersistedInput, PartialReason } from "./types.ts";

export interface PlanRefreshResult {
  jobPlanned: boolean;
  partialReason?: PartialReason;
}

export async function planRefresh(ctx: TickContext): Promise<PlanRefreshResult> {
  if (ctx.deadline.isExpired()) return { jobPlanned: false, partialReason: "DEADLINE" };

  const now = ctx.clock.now();
  const slotStart = computeSlotStart(now, REFRESH_SLOT_HOURS_UTC);
  const slotKey = buildSlotKey("refresh", "tiktok", ctx.market, slotStart);

  const run = await createCollectionRun(ctx.db, {
    kind: "REFRESH",
    slotKey,
    plannedAt: slotStart,
    triggeredBy: "tick",
  });

  const existingJobs = await getJobsForCollectionRun(ctx.db, run.id);
  if (existingJobs.length > 0) {
    const allFailed = existingJobs.every((j) => j.status === "FAILED" || j.status === "TIMED_OUT");
    if (!allFailed || existingJobs.length >= MAX_JOB_ATTEMPTS_PER_RUN) {
      return { jobPlanned: false };
    }
  }

  const candidates = await getRefreshCandidatePosts(ctx.db, now, REFRESH_MAX_POSTS_PER_RUN * 2);
  const due = candidates.filter((c) => isRefreshDue(c, now)).slice(0, REFRESH_MAX_POSTS_PER_RUN);

  if (due.length === 0) {
    await finalizeCollectionRun(ctx.db, run.id, { status: "SKIPPED", now, recordsUsed: 0 });
    return { jobPlanned: false };
  }

  let provider;
  try {
    provider = await ctx.providers.resolveAvailable("tiktok", "REFRESH", ctx.circuitBreaker);
  } catch (error) {
    if (isProviderError(error)) {
      await finalizeCollectionRun(ctx.db, run.id, { status: "SKIPPED", now, recordsUsed: 0, errorSummary: error.message });
      return { jobPlanned: false, partialReason: "PROVIDER_UNAVAILABLE" };
    }
    throw error;
  }

  if (!isProviderId(provider.id)) {
    throw new Error(`planRefresh: resolved a non-persistable provider id "${provider.id}"`);
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

  const input: RefreshJobPersistedInput = {
    posts: due.map((c) => ({ postId: c.postId, externalId: c.externalId, canonicalUrl: c.canonicalUrl })),
  };

  await planProviderJob(ctx.db, {
    collectionRunId: run.id,
    provider: provider.id,
    platform: "tiktok",
    jobType: "POST_REFRESH",
    input: input as unknown as Record<string, unknown>,
  });
  await startCollectionRun(ctx.db, run.id, now);

  return { jobPlanned: true };
}
