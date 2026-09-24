/**
 * Ingest phase (Phase 5 brief §23-27, §36, §50-51): for each READY job,
 * fetch its results (paginating until nextCursor is exhausted — never
 * silently truncated), normalize each item through the existing Phase 2
 * normalizers, persist good ones through Phase 3 repositories, and
 * quarantine the rest. One malformed item never fails the whole job.
 */
import {
  acquireIngestLease,
  getIngestableJobIds,
  getProviderJobById,
  markJobIngested,
  releaseLease,
  type ProviderJobRow,
} from "@/db/repositories/provider-jobs.ts";
import { recordErrorEvent } from "@/db/repositories/error-events.ts";
import { quarantineItem } from "@/db/repositories/quarantine.ts";
import { persistNormalizedObservation } from "@/db/repositories/posts.ts";
import { recordHashtagScanned } from "@/db/repositories/tracking.ts";
import { recordRefreshCompletion } from "@/db/repositories/posts.ts";
import { normalizeProviderPost } from "@/providers/normalize.ts";
import { estimateCostUsd } from "@/providers/cost.ts";
import { computeNextRefreshAt } from "@/core/scheduling/refresh-planner.ts";
import { JOB_LEASE_MS, TICK_LIMITS } from "@/config/schedule.ts";
import type { DiscoveryJobPersistedInput, PartialReason, RefreshJobPersistedInput, TickContext } from "./types.ts";

const MAX_PAGES = 50;

export interface IngestJobsResult {
  ingested: number;
  itemsPersisted: number;
  itemsQuarantined: number;
  failed: number;
  partialReasons: PartialReason[];
}

export async function ingestReadyJobs(ctx: TickContext): Promise<IngestJobsResult> {
  const result: IngestJobsResult = { ingested: 0, itemsPersisted: 0, itemsQuarantined: 0, failed: 0, partialReasons: [] };
  const now0 = ctx.clock.now();
  const ids = await getIngestableJobIds(ctx.db, now0, TICK_LIMITS.maxIngestions);

  for (const id of ids) {
    if (ctx.deadline.isExpired()) {
      result.partialReasons.push("DEADLINE");
      break;
    }

    const now = ctx.clock.now();
    const leased = await acquireIngestLease(ctx.db, id, now, new Date(now.getTime() + JOB_LEASE_MS));
    if (!leased) continue;

    const row = await getProviderJobById(ctx.db, id);
    if (!row || row.status !== "READY" || !row.externalJobId) {
      await releaseLease(ctx.db, id);
      continue;
    }

    try {
      const outcome = await ingestOneJob(ctx, row);
      result.ingested += 1;
      result.itemsPersisted += outcome.persisted;
      result.itemsQuarantined += outcome.quarantined;
      if (outcome.quarantined > 0) result.partialReasons.push("QUARANTINED_ITEMS");
    } catch (error) {
      // Leave the job READY (lease released) so a later tick retries —
      // every write this function makes is idempotent on replay (upserts,
      // onConflictDoNothing, dedup-checked quarantine), so a partial
      // crash never produces duplicate/corrupt state (Phase 5 brief §37).
      await releaseLease(ctx.db, id);
      result.failed += 1;
      result.partialReasons.push("PARTIAL_PROVIDER_FAILURE");
      await recordErrorEvent(ctx.db, {
        at: ctx.clock.now(),
        scope: "jobs.ingest",
        severity: "ERROR",
        message: error instanceof Error ? error.message : String(error),
        context: { jobId: id, provider: row.provider, platform: row.platform },
      });
    }
  }

  return result;
}

async function ingestOneJob(ctx: TickContext, row: ProviderJobRow): Promise<{ persisted: number; quarantined: number }> {
  const provider = ctx.providers.getById(row.provider);
  const items = await fetchAllPages(provider, row.externalJobId!);
  const observedAt = ctx.clock.now();

  let persisted = 0;
  let quarantined = 0;

  if (row.jobType === "HASHTAG_DISCOVERY") {
    const input = row.input as unknown as DiscoveryJobPersistedInput;
    const singleQuery = input.queries.length === 1 ? input.queries[0] : null;

    for (const [index, raw] of items.entries()) {
      const normalized = normalizeProviderPost({
        provider: row.provider,
        platform: row.platform,
        raw,
        context: { observedAt, discoveryMethod: "search" },
      });
      if (normalized.ok) {
        await persistNormalizedObservation(ctx.db, {
          post: normalized.post,
          snapshotSource: "DISCOVERY",
          providerJobId: row.id,
          discovery: singleQuery
            ? { hashtagId: singleQuery.hashtagId, queryText: singleQuery.query, rankInResults: index }
            : { hashtagId: null, queryText: null, rankInResults: null },
        });
        persisted += 1;
      } else {
        const inserted = await quarantineItem(ctx.db, {
          provider: row.provider,
          platform: row.platform,
          providerJobId: row.id,
          payload: toQuarantinePayload(raw),
          error: `${normalized.kind}: ${normalized.reason}`,
          now: observedAt,
        });
        if (inserted.inserted) quarantined += 1;
      }
    }

    const seenTrackedHashtagIds = new Set<number>();
    for (const q of input.queries) {
      if (seenTrackedHashtagIds.has(q.trackedHashtagId)) continue;
      seenTrackedHashtagIds.add(q.trackedHashtagId);
      await recordHashtagScanned(ctx.db, q.trackedHashtagId, {
        tier: q.tier,
        source: q.source,
        trendState: q.trendState,
        now: observedAt,
        // Attribution is batch-wide, not per-query (no verified provider
        // field maps a result to a specific query — Phase 4 brief §51) —
        // every tag in this batch shares the same "was this batch
        // productive at all" empty-scan signal.
        recordsReturned: persisted,
      });
    }
  } else {
    const input = row.input as unknown as RefreshJobPersistedInput;
    const requestedExternalIds = new Set(input.posts.map((p) => p.externalId));

    for (const raw of items) {
      const normalized = normalizeProviderPost({
        provider: row.provider,
        platform: row.platform,
        raw,
        context: { observedAt, discoveryMethod: "refresh" },
      });
      if (normalized.ok) {
        const persistedResult = await persistNormalizedObservation(ctx.db, {
          post: normalized.post,
          snapshotSource: "REFRESH",
          providerJobId: row.id,
        });
        persisted += 1;
        if (requestedExternalIds.has(normalized.post.externalId)) {
          await recordRefreshCompletion(ctx.db, persistedResult.postId, {
            refreshedAt: observedAt,
            nextRefreshAt: computeNextRefreshAt(observedAt),
          });
        }
      } else {
        const inserted = await quarantineItem(ctx.db, {
          provider: row.provider,
          platform: row.platform,
          providerJobId: row.id,
          payload: toQuarantinePayload(raw),
          error: `${normalized.kind}: ${normalized.reason}`,
          now: observedAt,
        });
        if (inserted.inserted) quarantined += 1;
      }
    }
  }

  await markJobIngested(ctx.db, row.id, {
    recordsReturned: persisted,
    recordsQuarantined: quarantined,
    ingestedAt: observedAt,
    costEstUsd: estimateCostUsd(row.provider, persisted),
  });
  return { persisted, quarantined };
}

async function fetchAllPages(
  provider: { fetchResults: (externalJobId: string, cursor?: string) => Promise<{ items: unknown[]; nextCursor: string | null }> },
  externalJobId: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await provider.fetchResults(externalJobId, cursor);
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

function toQuarantinePayload(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { value: raw };
}
