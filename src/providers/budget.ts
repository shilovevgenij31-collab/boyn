/**
 * Budget calculation / allow-deny decisions from persisted provider_jobs
 * (Phase 4 brief §19-21). Phase 4 does NOT schedule collection slots —
 * this only answers "is there room to submit more work right now",
 * which Phase 5's scheduler will call before submitting a job.
 *
 * Decimal safety: the SQL SUM (repositories/runs.ts) is exact (Postgres
 * NUMERIC); this module parses that exact string to a JS number exactly
 * ONCE per status computation for a single final threshold comparison —
 * not accumulated in JS across many additions, so IEEE 754 precision at
 * these single/double-digit-dollar magnitudes is a complete non-issue
 * (doubles are exact far beyond $10.000000). Do not refactor this to sum
 * costs in a loop in JS instead.
 */
import type { Database } from "@/db/client.ts";
import { getProviderUsageSince } from "@/db/repositories/runs.ts";
import type { ProviderId } from "@/core/domain/provider.ts";
import type { Env } from "@/config/env.ts";
import { BUDGET_PROFILES, DEFAULT_BUDGET_PROFILE, type BudgetProfileName } from "@/config/budget.ts";

/** Deploy-level overrides for the profile's dollar ceilings (Phase 4
 * brief §20's `BUDGET_MONTHLY_USD_MAX`/`BUDGET_APIFY_MONTHLY_USD_MAX` env
 * vars) — lets an operator tighten or loosen the cap without switching
 * BUDGET_PROFILE (which also changes the daily record limit). */
export interface BudgetOverrides {
  monthlyUsdMax?: number;
  apifyMonthlyUsdMax?: number;
}

export function buildBudgetOverridesFromEnv(env: Env): BudgetOverrides {
  return {
    monthlyUsdMax: env.BUDGET_MONTHLY_USD_MAX !== undefined ? Number(env.BUDGET_MONTHLY_USD_MAX) : undefined,
    apifyMonthlyUsdMax:
      env.BUDGET_APIFY_MONTHLY_USD_MAX !== undefined ? Number(env.BUDGET_APIFY_MONTHLY_USD_MAX) : undefined,
  };
}

export interface BudgetStatus {
  profile: BudgetProfileName;
  usedToday: number;
  usedThisMonth: number;
  estimatedUsdMonth: number;
  apifyUsdMonth: number;
  remainingDailyRecords: number;
  remainingMonthlyUsd: number;
  dailyRecordsExceeded: boolean;
  monthlyUsdExceeded: boolean;
  apifyMonthlyUsdExceeded: boolean;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getBudgetStatus(
  db: Database,
  now: Date,
  profileName: BudgetProfileName = DEFAULT_BUDGET_PROFILE,
  overrides: BudgetOverrides = {},
): Promise<BudgetStatus> {
  const profile = BUDGET_PROFILES[profileName];
  const monthlyUsdMax = overrides.monthlyUsdMax ?? profile.monthlyUsdMax;
  const apifyMonthlyUsdMax = overrides.apifyMonthlyUsdMax ?? profile.apifyMonthlyUsdMax;

  const [dayUsage, monthUsage, apifyMonthUsage] = await Promise.all([
    getProviderUsageSince(db, startOfUtcDay(now)),
    getProviderUsageSince(db, startOfUtcMonth(now)),
    getProviderUsageSince(db, startOfUtcMonth(now), "apify" satisfies ProviderId),
  ]);

  const estimatedUsdMonth = Number(monthUsage.costUsd);
  const apifyUsdMonth = Number(apifyMonthUsage.costUsd);

  return {
    profile: profileName,
    usedToday: dayUsage.recordsUsed,
    usedThisMonth: monthUsage.recordsUsed,
    estimatedUsdMonth,
    apifyUsdMonth,
    remainingDailyRecords: Math.max(0, profile.dailyRecordLimit - dayUsage.recordsUsed),
    remainingMonthlyUsd: Math.max(0, monthlyUsdMax - estimatedUsdMonth),
    dailyRecordsExceeded: dayUsage.recordsUsed >= profile.dailyRecordLimit,
    monthlyUsdExceeded: estimatedUsdMonth >= monthlyUsdMax,
    apifyMonthlyUsdExceeded: apifyUsdMonth >= apifyMonthlyUsdMax,
  };
}

/** The hard gate (Phase 4 brief §20): once the monthly USD ceiling is
 * hit, no more automatic submission — daily record limit is a softer,
 * same-severity check for the common case of hitting it first. Per-
 * provider (Apify) exhaustion blocks only that provider, handled
 * separately by the registry, not here. */
export function canSubmit(status: BudgetStatus): boolean {
  return !status.monthlyUsdExceeded && !status.dailyRecordsExceeded;
}

export function canSubmitToProvider(status: BudgetStatus, provider: ProviderId): boolean {
  if (!canSubmit(status)) return false;
  if (provider === "apify" && status.apifyMonthlyUsdExceeded) return false;
  return true;
}
