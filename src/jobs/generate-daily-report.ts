/**
 * Daily report generation orchestration (Phase 7 brief §6, §51-52):
 * fetches bounded report-data (src/db/repositories/report-data.ts),
 * derives partial reasons from real persisted collection state, calls
 * the pure `buildDailyReport`, and freezes the result via
 * `upsertDailyReport`. No ranking/window logic lives here — that's
 * core/report/build-daily-report.ts.
 */
import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import type { Market } from "@/core/domain/market.ts";
import { REPORT_WINDOW_HOURS } from "@/config/report.ts";
import { SCORING_VERSION } from "@/config/scoring.ts";
import { buildDailyReport } from "@/core/report/build-daily-report.ts";
import { formatReportDate } from "@/core/report/report-date.ts";
import type { DailyReport, PartialReason } from "@/core/report/types.ts";
import {
  getClusterEdges,
  getCollectionSummary,
  getHashtagSections,
  getPlatformCollectionOutcomes,
  getReportCandidatePosts,
  getTagAggregatesForDate,
  getTierEvents,
  hasUnfinishedCollectionRuns,
} from "@/db/repositories/report-data.ts";
import { getBudgetStatus } from "@/providers/budget.ts";
import { getPreviousDailyReport, upsertDailyReport } from "@/db/repositories/reports.ts";
import type { BudgetProfileName } from "@/config/budget.ts";
import { DEFAULT_BUDGET_PROFILE } from "@/config/budget.ts";

export interface GenerateDailyReportParams {
  db: Database;
  clock: Clock;
  market: Market;
  timezone: string;
  budgetProfile?: BudgetProfileName;
  /** Partial reasons the caller already knows about from an earlier stage
   * of the daily pipeline (e.g. `analytics:failed`, detected by run-daily
   * from a just-recorded error_event) — merged with the reasons this
   * function derives from collection state itself. */
  extraPartialReasons?: PartialReason[];
}

export interface GenerateDailyReportResult {
  reportDate: string;
  status: DailyReport["status"];
  partialReasons: PartialReason[];
  written: boolean;
  reportId: number;
}

export async function generateDailyReport(params: GenerateDailyReportParams): Promise<GenerateDailyReportResult> {
  const { db, clock, market } = params;
  const now = clock.now();
  const timezone = params.timezone;
  const reportDate = formatReportDate(now, timezone);

  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - REPORT_WINDOW_HOURS.today * 3_600_000);
  const dateStr = windowEnd.toISOString().slice(0, 10);

  const [candidatePosts, collection, tierEvents, clusterEdges, tagAggregates, platformOutcomes, unfinished, budget, previousReport] = await Promise.all([
    getReportCandidatePosts(db, market, now, REPORT_WINDOW_HOURS.stillHotOuter),
    getCollectionSummary(db, market, windowStart, windowEnd),
    getTierEvents(db, market, windowStart, windowEnd),
    getClusterEdges(db, market, dateStr),
    getTagAggregatesForDate(db, market, dateStr),
    getPlatformCollectionOutcomes(db, windowStart, windowEnd),
    hasUnfinishedCollectionRuns(db, windowStart, windowEnd),
    getBudgetStatus(db, now, params.budgetProfile ?? DEFAULT_BUDGET_PROFILE),
    getPreviousDailyReport(db, reportDate, market),
  ]);

  const hashtagSections = await getHashtagSections(db, market, now, clusterEdges);

  const partialReasons: PartialReason[] = [...(params.extraPartialReasons ?? [])];
  for (const platform of ["tiktok", "instagram"] as const) {
    const outcome = platformOutcomes[platform];
    if (outcome.jobs > 0 && outcome.failed === outcome.jobs) partialReasons.push(`${platform}:discovery_failed`);
    else if (outcome.failed > 0) partialReasons.push(`${platform}:discovery_partial`);
  }
  if (unfinished) partialReasons.push("collection:unfinished_jobs");
  if (budget.monthlyUsdExceeded) partialReasons.push("collection:budget_exhausted");

  const yesterdayPostIds = new Set<number>();
  if (previousReport) {
    for (const item of [...previousReport.todayTop, ...previousReport.stillHot]) yesterdayPostIds.add(item.postId);
  }

  const report = buildDailyReport({
    now,
    reportDate,
    timezone,
    market,
    scoringVersion: SCORING_VERSION,
    candidatePosts,
    yesterdayPostIds,
    yesterday: previousReport
      ? { viralQualified: previousReport.counts.viralQualified, earlyBreakout: previousReport.counts.earlyBreakout, postsScanned: previousReport.collection.postsScannedTotal }
      : null,
    collection,
    partialReasons: dedupe(partialReasons),
    hashtagSections,
    newlyTracked: tierEvents.newlyTracked,
    demoted: tierEvents.demoted,
    clusterEdges,
    tagTotalPosts: tagAggregates.tagTotalPosts,
    tagStrength: tagAggregates.tagStrength,
  });

  const upsertResult = await upsertDailyReport(db, {
    reportDate,
    market,
    windowStart,
    windowEnd,
    status: report.status,
    partialReasons: report.partialReasons,
    payload: report,
    scoringVersion: SCORING_VERSION,
    generatedAt: now,
  });

  return { reportDate, status: report.status, partialReasons: report.partialReasons, written: upsertResult.written, reportId: upsertResult.id };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
