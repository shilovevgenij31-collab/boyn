/**
 * Bounded, N+1-avoiding queries for `/status` (Phase 8 brief §43-44, §70)
 * — everything here reads already-persisted application state; no live
 * provider health request is ever made (brief §43's "No live Apify/Bright
 * Data health request").
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { errorEvents, providerJobs, trackedHashtags } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { TrackingTier } from "@/core/domain/tracking.ts";

export interface LatestCollectionActivity {
  lastTiktokDiscovery: Date | null;
  lastInstagramDiscovery: Date | null;
  lastRefresh: Date | null;
}

async function maxSubmittedAt(db: Database, jobType: "HASHTAG_DISCOVERY" | "POST_REFRESH", platform?: Platform): Promise<Date | null> {
  const conditions = [eq(providerJobs.jobType, jobType), isNotNull(providerJobs.submittedAt)];
  if (platform) conditions.push(eq(providerJobs.platform, platform));
  const [row] = await db.select({ max: sql<string | null>`max(${providerJobs.submittedAt})` }).from(providerJobs).where(and(...conditions));
  return row?.max ? new Date(row.max) : null;
}

export async function getLatestCollectionActivity(db: Database): Promise<LatestCollectionActivity> {
  const [lastTiktokDiscovery, lastInstagramDiscovery, lastRefresh] = await Promise.all([
    maxSubmittedAt(db, "HASHTAG_DISCOVERY", "tiktok"),
    maxSubmittedAt(db, "HASHTAG_DISCOVERY", "instagram"),
    maxSubmittedAt(db, "POST_REFRESH"),
  ]);
  return { lastTiktokDiscovery, lastInstagramDiscovery, lastRefresh };
}

export async function getTrackedTierCounts(db: Database, market: string): Promise<Record<TrackingTier, number>> {
  const rows = await db.select({ tier: trackedHashtags.tier, n: sql<string>`count(*)` }).from(trackedHashtags).where(eq(trackedHashtags.market, market)).groupBy(trackedHashtags.tier);
  const result: Record<TrackingTier, number> = { CORE: 0, ACTIVE: 0, EXPLORATION: 0, DORMANT: 0 };
  for (const r of rows) result[r.tier] = Number(r.n);
  return result;
}

export interface RecentErrorRow {
  at: Date;
  scope: string;
  severity: string;
  message: string;
}

/** Safe summary fields only — never the raw `context` payload, which may
 * carry provider job ids or other operational detail not meant for a
 * chat message (brief §44). */
export async function getRecentErrorEvents(db: Database, since: Date, limit: number): Promise<RecentErrorRow[]> {
  return db.select({ at: errorEvents.at, scope: errorEvents.scope, severity: errorEvents.severity, message: errorEvents.message }).from(errorEvents).where(gte(errorEvents.at, since)).orderBy(desc(errorEvents.at)).limit(limit);
}
