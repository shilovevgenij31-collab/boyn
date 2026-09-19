/**
 * The daily pipeline entry point (Phase 7 brief §4-5, §54-56; delivery
 * stage added by the Phase 8/9 production hotfix — see §24-27): analytics,
 * then the frozen DailyReport, then Telegram delivery of that report,
 * then retention, then a dead-man scheduler check — as isolated stages,
 * in that exact order. A failure in one stage must never corrupt or block
 * the others: `runAnalytics` already catches and records its own failures
 * (jobs/run-analytics.ts) rather than throwing; this orchestrator does the
 * same for report generation, delivery, and retention, so e.g. Telegram
 * being unreachable never prevents retention from running, and a broken
 * report never prevents Telegram delivery from at least being attempted
 * for whatever report state exists.
 *
 * This is NOT a replacement for the external ~30-min collection tick
 * (src/jobs/tick.ts / /api/cron/tick) — it never plans or submits
 * provider jobs itself (brief §53). It is the once-daily maintenance
 * pass: score what the tick collected, freeze today's report, deliver it
 * to Telegram, prune expired rows, and flag a stale scheduler.
 */
import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import type { Deadline } from "@/lib/deadline.ts";
import type { Market } from "@/core/domain/market.ts";
import type { BudgetProfileName } from "@/config/budget.ts";
import { DEAD_MAN_THRESHOLD_MINUTES } from "@/config/retention.ts";
import { runAnalytics, type AnalyticsStats } from "./run-analytics.ts";
import { generateDailyReport, type GenerateDailyReportResult } from "./generate-daily-report.ts";
import { runRetention } from "./retention.ts";
import type { RetentionResult } from "@/db/repositories/retention.ts";
import { hasErrorEventSince, recordErrorEvent } from "@/db/repositories/error-events.ts";
import { getMostRecentCollectionRunPlannedAt } from "@/db/repositories/runs.ts";
import { deliverDailyReport } from "@/telegram/deliver-report.ts";
import type { TelegramCommandContext } from "@/telegram/context.ts";

export interface RunDailyParams {
  db: Database;
  clock: Clock;
  market: Market;
  timezone: string;
  budgetProfile?: BudgetProfileName;
  /** Bounds the analytics stage (brief §54's "bounded pipeline, no
   * synchronous provider job waits") — report generation, retention, and
   * the dead-man check are all bounded, cheap, fixed-shape queries and
   * don't need their own deadline check. */
  deadline?: Deadline;
  /** Present only when Telegram is actually configured (brief §24-27
   * production hotfix) — `deliverDailyReport` only needs `db`/`clock`/
   * `market`/`client`/`reportChatId` off this, but the full context is
   * accepted as-is rather than inventing a narrower type. `undefined`
   * means delivery is simply skipped (never a hard failure) — matches
   * how a missing `TELEGRAM_REPORT_CHAT_ID` is already handled inside
   * `deliverDailyReport` itself. */
  telegramContext?: TelegramCommandContext;
}

export interface DeadManCheckResult {
  stale: boolean;
  lastActivityAt: string | null;
  thresholdMinutes: number;
}

export interface DailyDeliveryOutcome {
  attempted: boolean;
  delivered: boolean;
  alreadyDelivered: boolean;
  skippedReason?: string;
}

export interface RunDailyResult {
  startedAt: string;
  finishedAt: string;
  analytics: AnalyticsStats;
  report: GenerateDailyReportResult;
  delivery: DailyDeliveryOutcome;
  retention: RetentionResult;
  deadMan: DeadManCheckResult;
}

const ANALYTICS_ERROR_SCOPE = "jobs.run-analytics";
const DEAD_MAN_ERROR_SCOPE = "jobs.run-daily.dead-man";

export async function runDaily(params: RunDailyParams): Promise<RunDailyResult> {
  const { db, clock, market, timezone } = params;
  const startedAt = clock.now();

  // ---- 1) Analytics. runAnalytics never throws (it catches internally and
  // records an error_event); this run's own report-generation partial
  // reason is derived from whether that error_event actually landed just
  // now, not from parsing its returned stats. ----
  const analytics = await runAnalytics({ db, clock, market, deadline: params.deadline });
  const analyticsFailed = await hasErrorEventSince(db, ANALYTICS_ERROR_SCOPE, startedAt);

  // ---- 2) Daily report — frozen from whatever analytics state exists,
  // PARTIAL (never a fabricated COMPLETE) if analytics just failed. ----
  let report: GenerateDailyReportResult;
  try {
    report = await generateDailyReport({
      db,
      clock,
      market,
      timezone,
      budgetProfile: params.budgetProfile,
      extraPartialReasons: analyticsFailed ? ["analytics:failed"] : [],
    });
  } catch (error) {
    await recordErrorEvent(db, {
      at: clock.now(),
      scope: "jobs.run-daily.report",
      severity: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      context: { market },
    });
    report = { reportDate: "", status: "PARTIAL", partialReasons: ["report:generation_failed"], written: false, reportId: -1 };
  }

  // ---- 3) Deliver the frozen report to Telegram (brief §24-27 production
  // hotfix — this stage was previously missing entirely: the daily cron
  // generated/froze a report but nothing ever sent it). Only attempted
  // when report generation actually produced a report (never on the
  // `reportDate: ""` failure fallback above) and Telegram is configured.
  // A delivery failure is recorded and reported but never treated as an
  // analytics/report failure — the frozen report is valid regardless of
  // whether Telegram could be reached (brief §26). Idempotency is entirely
  // `deliverDailyReport`'s own (delivered_at/telegram_message_ids) —
  // nothing duplicated here. ----
  let delivery: DailyDeliveryOutcome = { attempted: false, delivered: false, alreadyDelivered: false };
  if (params.telegramContext && report.reportDate !== "") {
    try {
      const result = await deliverDailyReport(params.telegramContext, report.reportDate);
      delivery = { attempted: true, delivered: result.delivered, alreadyDelivered: result.alreadyDelivered, skippedReason: result.skippedReason };
    } catch (error) {
      await recordErrorEvent(db, {
        at: clock.now(),
        scope: "jobs.run-daily.delivery",
        severity: "ERROR",
        message: error instanceof Error ? error.message : String(error),
        context: { market, reportDate: report.reportDate },
      });
      delivery = { attempted: true, delivered: false, alreadyDelivered: false, skippedReason: "delivery_failed" };
    }
  }

  // ---- 4) Retention — independent of whether the report/delivery above succeeded. ----
  let retention: RetentionResult;
  try {
    retention = await runRetention({ db, clock, dryRun: false });
  } catch (error) {
    await recordErrorEvent(db, {
      at: clock.now(),
      scope: "jobs.run-daily.retention",
      severity: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      context: { market },
    });
    retention = {
      dryRun: false,
      postsDeleted: 0,
      snapshotsDeleted: 0,
      discoveriesDeleted: 0,
      cooccurrenceDeleted: 0,
      hashtagDailyStatsDeleted: 0,
      dailyReportsDeleted: 0,
      collectionRunsDeleted: 0,
      providerJobsDeleted: 0,
      resultViewsDeleted: 0,
      quarantinedItemsDeleted: 0,
      telegramUpdatesDeleted: 0,
      errorEventsDeleted: 0,
    };
  }

  // ---- 5) Dead-man / scheduler health check — last of the stages, so it
  // never affects today's report content. No Telegram alert here; a stale
  // scheduler is recorded once per day, not on every daily-cron rerun. ----
  const now = clock.now();
  const lastActivity = await getMostRecentCollectionRunPlannedAt(db);
  const staleMs = lastActivity ? now.getTime() - lastActivity.getTime() : Number.POSITIVE_INFINITY;
  const stale = staleMs > DEAD_MAN_THRESHOLD_MINUTES * 60_000;
  if (stale) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const alreadyRecordedToday = await hasErrorEventSince(db, DEAD_MAN_ERROR_SCOPE, dayStart);
    if (!alreadyRecordedToday) {
      await recordErrorEvent(db, {
        at: now,
        scope: DEAD_MAN_ERROR_SCOPE,
        severity: "WARN",
        message: "no collection run activity within the dead-man threshold — the external tick scheduler may be stale",
        context: { market, lastActivityAt: lastActivity?.toISOString() ?? null, thresholdMinutes: DEAD_MAN_THRESHOLD_MINUTES },
      });
    }
  }

  const finishedAt = clock.now();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    analytics,
    report,
    delivery,
    retention,
    deadMan: { stale, lastActivityAt: lastActivity?.toISOString() ?? null, thresholdMinutes: DEAD_MAN_THRESHOLD_MINUTES },
  };
}
