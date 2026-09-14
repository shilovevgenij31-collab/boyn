/**
 * `daily_reports` persistence (Phase 7 brief §32-34): idempotent by
 * (report_date, market), and immutable once generated — the simplest
 * safe rule for a phase with no delivery yet (brief §33): a report is
 * only ever upserted while `delivered_at IS NULL`. Once Phase 8 sets
 * `delivered_at`, this repository refuses to overwrite it again, so a
 * delivered report's frozen payload never silently changes under a
 * future admin regeneration feature this phase doesn't build.
 */
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { dailyReports } from "@/db/schema.ts";
import type { Market } from "@/core/domain/market.ts";
import type { DailyReport } from "@/core/report/types.ts";

export interface UpsertDailyReportParams {
  reportDate: string;
  market: Market;
  windowStart: Date;
  windowEnd: Date;
  status: "COMPLETE" | "PARTIAL";
  partialReasons: string[];
  payload: DailyReport;
  scoringVersion: number;
  generatedAt: Date;
}

export interface UpsertDailyReportResult {
  id: number;
  /** False when an already-delivered report for this (date, market)
   * existed and was left untouched (brief §33). */
  written: boolean;
}

export async function upsertDailyReport(db: Database, params: UpsertDailyReportParams): Promise<UpsertDailyReportResult> {
  const existing = await db
    .select({ id: dailyReports.id, deliveredAt: dailyReports.deliveredAt })
    .from(dailyReports)
    .where(and(eq(dailyReports.reportDate, params.reportDate), eq(dailyReports.market, params.market)))
    .limit(1);

  if (existing[0] && existing[0].deliveredAt !== null) {
    return { id: existing[0].id, written: false };
  }

  const rows = await db
    .insert(dailyReports)
    .values({
      reportDate: params.reportDate,
      market: params.market,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      status: params.status,
      partialReasons: params.partialReasons,
      payload: params.payload as unknown as Record<string, unknown>,
      scoringVersion: params.scoringVersion,
      generatedAt: params.generatedAt,
    })
    .onConflictDoUpdate({
      target: [dailyReports.reportDate, dailyReports.market],
      set: {
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        status: params.status,
        partialReasons: params.partialReasons,
        payload: params.payload as unknown as Record<string, unknown>,
        scoringVersion: params.scoringVersion,
        generatedAt: params.generatedAt,
      },
      // Never re-upsert over an already-delivered report — matches the
      // pre-check above; this WHERE guards the rare race where delivery
      // happens between the check and this statement.
      setWhere: isNull(dailyReports.deliveredAt),
    })
    .returning({ id: dailyReports.id });

  const row = rows[0];
  if (!row) throw new Error("upsertDailyReport: insert/update returned no row");
  return { id: row.id, written: true };
}

export async function getDailyReport(db: Database, reportDate: string, market: Market): Promise<DailyReport | null> {
  const rows = await db
    .select({ payload: dailyReports.payload })
    .from(dailyReports)
    .where(and(eq(dailyReports.reportDate, reportDate), eq(dailyReports.market, market)))
    .limit(1);
  return (rows[0]?.payload as unknown as DailyReport) ?? null;
}

/** The most recent frozen report for this market, regardless of date —
 * what `/today` and `/export` read (brief §33, §45): "the latest frozen
 * DailyReport", not necessarily today's calendar date if a run was
 * missed. */
export async function getLatestDailyReport(db: Database, market: Market): Promise<DailyReport | null> {
  const rows = await db.select({ payload: dailyReports.payload }).from(dailyReports).where(eq(dailyReports.market, market)).orderBy(desc(dailyReports.reportDate)).limit(1);
  return (rows[0]?.payload as unknown as DailyReport) ?? null;
}

/** The most recent frozen report strictly before `reportDate` for this
 * market — source for the yesterday comparison and `inYesterdayReport`
 * (brief §25-26). `null` when none exists yet (e.g. the very first report
 * day), which the caller must treat as "no comparison", never a
 * fabricated 0% delta. */
export async function getPreviousDailyReport(db: Database, reportDate: string, market: Market): Promise<DailyReport | null> {
  const rows = await db
    .select({ payload: dailyReports.payload })
    .from(dailyReports)
    .where(and(lt(dailyReports.reportDate, reportDate), eq(dailyReports.market, market)))
    .orderBy(desc(dailyReports.reportDate))
    .limit(1);
  return (rows[0]?.payload as unknown as DailyReport) ?? null;
}

export interface DailyReportForDelivery {
  id: number;
  deliveredAt: Date | null;
  /** Each entry is `"<piece>:<telegramMessageId>"` (Phase 8 brief §66-67)
   * — a piece already present here was already sent on a prior (possibly
   * crashed) delivery attempt and must not be sent again. */
  telegramMessageIds: string[];
  payload: DailyReport;
}

export async function getDailyReportForDelivery(db: Database, reportDate: string, market: Market): Promise<DailyReportForDelivery | null> {
  const rows = await db
    .select({ id: dailyReports.id, deliveredAt: dailyReports.deliveredAt, telegramMessageIds: dailyReports.telegramMessageIds, payload: dailyReports.payload })
    .from(dailyReports)
    .where(and(eq(dailyReports.reportDate, reportDate), eq(dailyReports.market, market)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, deliveredAt: row.deliveredAt, telegramMessageIds: row.telegramMessageIds ?? [], payload: row.payload as unknown as DailyReport };
}

/** Records one delivered "piece" immediately after it's actually sent —
 * never batched until the end — so a crash between two pieces leaves an
 * accurate, resumable record of exactly what already went out (brief
 * §67). Does NOT set `delivered_at`; see `markDailyReportDelivered`. */
export async function appendDeliveredPiece(db: Database, id: number, piece: string, telegramMessageId: number): Promise<void> {
  const [row] = await db.select({ telegramMessageIds: dailyReports.telegramMessageIds }).from(dailyReports).where(eq(dailyReports.id, id)).limit(1);
  const current = row?.telegramMessageIds ?? [];
  await db
    .update(dailyReports)
    .set({ telegramMessageIds: [...current, `${piece}:${telegramMessageId}`] })
    .where(eq(dailyReports.id, id));
}

/** Only ever called after every applicable piece has been confirmed sent
 * (brief §66: "do NOT mark delivered_at before required sending
 * finishes"). */
export async function markDailyReportDelivered(db: Database, id: number, deliveredAt: Date): Promise<void> {
  await db.update(dailyReports).set({ deliveredAt }).where(eq(dailyReports.id, id));
}
