/**
 * Conservative per-record cost estimate for `provider_jobs.cost_est_usd`
 * (Phase 8/9 hotfix, production incident Part D). No provider adapter
 * currently surfaces a reliable actual-billed-cost figure from its API,
 * so this is the documented fallback: IMPLEMENTATION_PLAN.md §13's own
 * researched PAYG rates (config/budget.ts's USD_PER_1K_RECORDS).
 *
 * Called exactly once, at the single point a job is marked INGESTED
 * (jobs/ingest-job.ts) — never recomputed or re-summed, so a replay can't
 * double-count it (quarantine.ts's module comment: a job is only ever
 * marked INGESTED once).
 */
import type { ProviderId } from "@/core/domain/provider.ts";
import { USD_PER_1K_RECORDS } from "@/config/budget.ts";

/** Returns a string suitable for a `numeric` column — never a float
 * accumulated across multiple calls (see budget.ts's module comment on
 * decimal safety). */
export function estimateCostUsd(provider: ProviderId, recordsReturned: number): string {
  const usd = (recordsReturned / 1000) * USD_PER_1K_RECORDS[provider];
  return usd.toFixed(6);
}
