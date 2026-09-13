/**
 * Robust baseline persistence (Phase 6 brief §15-17, §48): one row per
 * (platform, market, metric), computed once per analytics run and reused
 * for every post scored in that run — never recomputed per post.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { scoringBaselines } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { BaselineMetric } from "@/config/scoring.ts";
import type { RobustBaseline } from "@/core/analytics/baselines.ts";

export interface BaselineUpsert {
  platform: Platform;
  market: string;
  metric: BaselineMetric;
  computedAt: Date;
  baseline: RobustBaseline;
}

/** Values are on the log1p scale (what robustZ actually consumes), not
 * raw units — documented here since the column names alone (`median`,
 * `mad`) don't say so. */
export async function upsertScoringBaseline(db: Database, params: BaselineUpsert): Promise<void> {
  await db
    .insert(scoringBaselines)
    .values({
      platform: params.platform,
      market: params.market,
      metric: params.metric,
      computedAt: params.computedAt,
      n: params.baseline.n,
      median: params.baseline.medianLog1p.toFixed(4),
      mad: params.baseline.madLog1p.toFixed(4),
    })
    .onConflictDoUpdate({
      target: [scoringBaselines.platform, scoringBaselines.market, scoringBaselines.metric],
      set: {
        computedAt: params.computedAt,
        n: params.baseline.n,
        median: params.baseline.medianLog1p.toFixed(4),
        mad: params.baseline.madLog1p.toFixed(4),
      },
    });
}

export async function getScoringBaseline(db: Database, platform: Platform, market: string, metric: BaselineMetric): Promise<RobustBaseline | null> {
  const rows = await db
    .select({ n: scoringBaselines.n, median: scoringBaselines.median, mad: scoringBaselines.mad })
    .from(scoringBaselines)
    .where(and(eq(scoringBaselines.platform, platform), eq(scoringBaselines.market, market), eq(scoringBaselines.metric, metric)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { n: row.n, medianLog1p: Number(row.median), madLog1p: Number(row.mad) };
}
