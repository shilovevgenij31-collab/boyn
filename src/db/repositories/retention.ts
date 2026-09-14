/**
 * Retention sweep (Phase 7 brief §35-38, §62-64): deletes rows past their
 * class's TTL (config/retention.ts), never infers a class from raw
 * metrics — posts use their actual persisted `tier`, everything else uses
 * its own age column. Every delete is a plain `DELETE ... WHERE <same
 * condition a dry run counted>`, so `dryRun: true` returns exactly the
 * counts a real run would delete, without touching a row.
 *
 * Deliberately NOT touched here (brief §38): tracked_hashtags,
 * hashtag_tier_events, scoring_baselines, app_settings, and any circuit-
 * breaker state — none of these have an explicit TTL, and they're either
 * current/active state or an audit trail this phase doesn't have a
 * mandate to prune.
 *
 * FK cascades matter here, not just per-table TTLs: deleting an expired
 * `posts` row cascades `post_snapshots`/`post_hashtags`/`post_categories`/
 * `post_discoveries` (all ON DELETE CASCADE from posts), which is correct
 * — none of that child data means anything once the post itself is gone.
 * Deleting an expired `collection_runs` row cascades its `provider_jobs`
 * the same way; `post_snapshots.provider_job_id`/`quarantined_items.
 * provider_job_id` are ON DELETE SET NULL, so a snapshot or quarantined
 * item never disappears merely because the job that produced it aged out
 * — each has its own independent TTL below. `daily_reports` are frozen
 * JSON payloads (brief §21) — deleting old posts never corrupts a
 * retained report's history, since the report doesn't reference posts by
 * FK at all.
 */
import { and, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import {
  collectionRuns,
  dailyReports,
  errorEvents,
  hashtagCooccurrenceDaily,
  hashtagDailyStats,
  postDiscoveries,
  postSnapshots,
  posts,
  providerJobs,
  quarantinedItems,
  resultViews,
  telegramUpdates,
} from "@/db/schema.ts";
import { POST_RETENTION_DAYS, RETENTION_DAYS } from "@/config/retention.ts";

function cutoffDaysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 3_600_000);
}

function cutoffDateStrDaysAgo(now: Date, days: number): string {
  return cutoffDaysAgo(now, days).toISOString().slice(0, 10);
}

/** Reads the count first, then (unless `dryRun`) deletes the same
 * condition — a dry run and a real run are always the same query, never
 * two different code paths that could silently drift apart. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- table shapes (composite vs single PK) differ too much across callers here to give this a narrower shared type without a generic that adds more noise than it removes.
async function sweep(db: Database, table: any, condition: SQL, dryRun: boolean): Promise<number> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(table).where(condition);
  const n = Number(row?.n ?? "0");
  if (!dryRun && n > 0) await db.delete(table).where(condition);
  return n;
}

export interface RetentionResult {
  dryRun: boolean;
  postsDeleted: number;
  snapshotsDeleted: number;
  discoveriesDeleted: number;
  cooccurrenceDeleted: number;
  hashtagDailyStatsDeleted: number;
  dailyReportsDeleted: number;
  collectionRunsDeleted: number;
  providerJobsDeleted: number;
  resultViewsDeleted: number;
  quarantinedItemsDeleted: number;
  telegramUpdatesDeleted: number;
  errorEventsDeleted: number;
}

export async function runRetentionSweep(db: Database, now: Date, dryRun: boolean): Promise<RetentionResult> {
  // ---- posts: tier-keyed TTL, age anchored on COALESCE(published_at, first_seen_at). ----
  const ageExpr = sql`coalesce(${posts.publishedAt}, ${posts.firstSeenAt})`;
  let postsDeleted = 0;
  postsDeleted += await sweep(db, posts, and(eq(posts.tier, "NOISE"), lt(ageExpr, cutoffDaysAgo(now, POST_RETENTION_DAYS.NOISE)))!, dryRun);
  postsDeleted += await sweep(db, posts, and(eq(posts.tier, "WATCH"), lt(ageExpr, cutoffDaysAgo(now, POST_RETENTION_DAYS.WATCH)))!, dryRun);
  postsDeleted += await sweep(
    db,
    posts,
    and(inArray(posts.tier, ["VIRAL_QUALIFIED", "EARLY_BREAKOUT"]), lt(ageExpr, cutoffDaysAgo(now, POST_RETENTION_DAYS.VIRAL_QUALIFIED)))!,
    dryRun,
  );
  postsDeleted += await sweep(db, posts, and(isNull(posts.tier), lt(ageExpr, cutoffDaysAgo(now, POST_RETENTION_DAYS.UNKNOWN)))!, dryRun);

  // ---- everything else: one age column, one TTL. ----
  const snapshotsDeleted = await sweep(db, postSnapshots, lt(postSnapshots.observedAt, cutoffDaysAgo(now, RETENTION_DAYS.postSnapshots)), dryRun);
  const discoveriesDeleted = await sweep(db, postDiscoveries, lt(postDiscoveries.observedAt, cutoffDaysAgo(now, RETENTION_DAYS.postDiscoveries)), dryRun);
  const cooccurrenceDeleted = await sweep(db, hashtagCooccurrenceDaily, lt(hashtagCooccurrenceDaily.date, cutoffDateStrDaysAgo(now, RETENTION_DAYS.hashtagCooccurrenceDaily)), dryRun);
  const hashtagDailyStatsDeleted = await sweep(db, hashtagDailyStats, lt(hashtagDailyStats.date, cutoffDateStrDaysAgo(now, RETENTION_DAYS.hashtagDailyStats)), dryRun);
  const dailyReportsDeleted = await sweep(db, dailyReports, lt(dailyReports.generatedAt, cutoffDaysAgo(now, RETENTION_DAYS.dailyReports)), dryRun);
  const resultViewsDeleted = await sweep(db, resultViews, lt(resultViews.createdAt, cutoffDaysAgo(now, RETENTION_DAYS.resultViews)), dryRun);
  const quarantinedItemsDeleted = await sweep(db, quarantinedItems, lt(quarantinedItems.createdAt, cutoffDaysAgo(now, RETENTION_DAYS.quarantinedItems)), dryRun);
  const telegramUpdatesDeleted = await sweep(db, telegramUpdates, lt(telegramUpdates.receivedAt, cutoffDaysAgo(now, RETENTION_DAYS.telegramUpdates)), dryRun);
  const errorEventsDeleted = await sweep(db, errorEvents, lt(errorEvents.at, cutoffDaysAgo(now, RETENTION_DAYS.errorEvents)), dryRun);

  // ---- collection_runs + cascaded provider_jobs: counted separately since
  // provider_jobs has no independent TTL of its own (brief §36) — it only
  // ever disappears by cascading with its parent run. ----
  const collectionRunsCutoff = cutoffDaysAgo(now, RETENTION_DAYS.collectionRunsAndProviderJobs);
  const staleRuns = await db.select({ id: collectionRuns.id }).from(collectionRuns).where(lt(collectionRuns.plannedAt, collectionRunsCutoff));
  const staleRunIds = staleRuns.map((r) => r.id);
  const providerJobsDeleted = staleRunIds.length > 0 ? await countProviderJobs(db, staleRunIds) : 0;
  const collectionRunsDeleted = staleRunIds.length;
  if (!dryRun && staleRunIds.length > 0) {
    // Cascades provider_jobs (ON DELETE CASCADE) — no separate delete needed.
    await db.delete(collectionRuns).where(inArray(collectionRuns.id, staleRunIds));
  }

  return {
    dryRun,
    postsDeleted,
    snapshotsDeleted,
    discoveriesDeleted,
    cooccurrenceDeleted,
    hashtagDailyStatsDeleted,
    dailyReportsDeleted,
    collectionRunsDeleted,
    providerJobsDeleted,
    resultViewsDeleted,
    quarantinedItemsDeleted,
    telegramUpdatesDeleted,
    errorEventsDeleted,
  };
}

async function countProviderJobs(db: Database, collectionRunIds: number[]): Promise<number> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(providerJobs).where(inArray(providerJobs.collectionRunId, collectionRunIds));
  return Number(row?.n ?? "0");
}
