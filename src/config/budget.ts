/**
 * Crawl budget profiles — see docs/IMPLEMENTATION_PLAN.md §13 for the
 * derivation of these numbers (Phase 0 left this file as an unpopulated
 * placeholder pending Phase 4, which is the first phase that actually
 * enforces a budget). Pure data: `src/providers/budget.ts` does the
 * DB-querying and allow/deny logic that consumes this.
 *
 * The owner-approved default is LEAN with a hard $10/month ceiling
 * (Phase 4 brief §20) — `BUDGET_MONTHLY_USD_MAX` in env can override the
 * ceiling; `BUDGET_PROFILE` selects which profile's record limits apply.
 */
export type BudgetProfileName = "FREE" | "LEAN" | "STANDARD";

export interface BudgetProfile {
  name: BudgetProfileName;
  /** Soft daily record ceiling — informational/allow-deny, not a hard kill. */
  dailyRecordLimit: number;
  /** Hard monthly USD ceiling for ALL providers combined — exceeding this
   * blocks further automatic submission (Phase 4 brief §20). */
  monthlyUsdMax: number;
  /** Sub-cap specifically for Apify, so its free-credit account never gets
   * blocked by exhausting the shared ceiling on Bright Data spend alone
   * (docs/IMPLEMENTATION_PLAN.md §13/ADR-014). */
  apifyMonthlyUsdMax: number;
}

export const BUDGET_PROFILES: Record<BudgetProfileName, BudgetProfile> = {
  FREE: { name: "FREE", dailyRecordLimit: 220, monthlyUsdMax: 1, apifyMonthlyUsdMax: 1 },
  LEAN: { name: "LEAN", dailyRecordLimit: 360, monthlyUsdMax: 10, apifyMonthlyUsdMax: 4.5 },
  STANDARD: { name: "STANDARD", dailyRecordLimit: 1050, monthlyUsdMax: 40, apifyMonthlyUsdMax: 20 },
};

export const DEFAULT_BUDGET_PROFILE: BudgetProfileName = "LEAN";
