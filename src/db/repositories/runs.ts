import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { collectionRuns, providerJobs } from "@/db/schema.ts";
import type { ProviderId } from "@/core/domain/provider.ts";

export interface CreateCollectionRunParams {
  kind: "DISCOVERY" | "REFRESH" | "MANUAL";
  slotKey: string;
  plannedAt: Date;
  budgetRecords?: number | null;
  triggeredBy?: string | null;
}

export interface CreateCollectionRunResult {
  id: number;
  created: boolean;
}

/**
 * Idempotent on `slot_key` (Phase 3 brief §19/§39-O): the future Phase 5
 * scheduler calls this once per (tick, slot) and can safely be invoked
 * more than once for the same slot — e.g. two overlapping ticks — without
 * creating a duplicate run.
 */
export async function createCollectionRun(
  db: Database,
  params: CreateCollectionRunParams,
): Promise<CreateCollectionRunResult> {
  const inserted = await db
    .insert(collectionRuns)
    .values({
      kind: params.kind,
      slotKey: params.slotKey,
      plannedAt: params.plannedAt,
      budgetRecords: params.budgetRecords ?? null,
      triggeredBy: params.triggeredBy ?? null,
    })
    .onConflictDoNothing({ target: collectionRuns.slotKey })
    .returning({ id: collectionRuns.id });

  if (inserted[0]) return { id: inserted[0].id, created: true };

  const existing = await db
    .select({ id: collectionRuns.id })
    .from(collectionRuns)
    .where(eq(collectionRuns.slotKey, params.slotKey))
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error("createCollectionRun: row neither inserted nor found — this should be unreachable");
  return { id: row.id, created: false };
}

export interface CreateProviderJobParams {
  collectionRunId: number;
  provider: "apify" | "brightdata";
  platform: "tiktok" | "instagram";
  jobType: "HASHTAG_DISCOVERY" | "POST_REFRESH";
  input?: Record<string, unknown> | null;
}

/** Plain insert — one row per submission attempt. No submit/poll logic
 * here (that's Phase 5); this exists so Phase 3's other repositories
 * (post_snapshots.provider_job_id, post_discoveries) have a real FK
 * target to test and build against. */
export async function createProviderJob(db: Database, params: CreateProviderJobParams): Promise<number> {
  const rows = await db
    .insert(providerJobs)
    .values({
      collectionRunId: params.collectionRunId,
      provider: params.provider,
      platform: params.platform,
      jobType: params.jobType,
      input: params.input ?? null,
    })
    .returning({ id: providerJobs.id });

  const row = rows[0];
  if (!row) throw new Error("createProviderJob: insert returned no row");
  return row.id;
}

export interface UsageTotals {
  recordsUsed: number;
  /** Exact decimal string (Postgres NUMERIC sum) — see src/db/schema.ts's
   * module comment on money types; never parsed to a JS number until a
   * single final comparison at the call site (src/providers/budget.ts). */
  costUsd: string;
}

/**
 * Sums directly from persisted `provider_jobs` rows — this is the ONLY
 * source of truth for usage (Phase 4 brief §19: "do NOT maintain a second
 * mutable counter that can drift"). A job with a null `submitted_at`
 * (never actually submitted) is naturally excluded by the `>=` filter,
 * which is correct: nothing was sent, nothing should count.
 */
export type CollectionRunStatus = "PLANNED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";

/** Idempotent: only a PLANNED run transitions to RUNNING; a run already
 * RUNNING (a later tick continuing the same multi-tick run, Phase 5 brief
 * §34) is left untouched rather than re-stamping startedAt. */
export async function startCollectionRun(db: Database, id: number, now: Date): Promise<void> {
  await db
    .update(collectionRuns)
    .set({ status: "RUNNING", startedAt: now })
    .where(and(eq(collectionRuns.id, id), eq(collectionRuns.status, "PLANNED")));
}

export interface FinalizeCollectionRunParams {
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";
  now: Date;
  recordsUsed?: number;
  stats?: Record<string, unknown>;
  errorSummary?: string | null;
}

export async function finalizeCollectionRun(db: Database, id: number, params: FinalizeCollectionRunParams): Promise<void> {
  await db
    .update(collectionRuns)
    .set({
      status: params.status,
      finishedAt: params.now,
      recordsUsed: params.recordsUsed,
      stats: params.stats ?? null,
      errorSummary: params.errorSummary ?? null,
    })
    .where(eq(collectionRuns.id, id));
}

export interface OpenCollectionRun {
  id: number;
  kind: "DISCOVERY" | "REFRESH" | "MANUAL";
  status: CollectionRunStatus;
}

/** Runs not yet in a terminal state — candidates for the finalize phase
 * (Phase 5 brief §32-34) to check whether all their provider_jobs are now
 * terminal and, if so, close them out. A run can legitimately stay open
 * across many ticks while a slow job (Bright Data) is still in flight. */
export async function getOpenCollectionRuns(db: Database, limit: number): Promise<OpenCollectionRun[]> {
  return db
    .select({ id: collectionRuns.id, kind: collectionRuns.kind, status: collectionRuns.status })
    .from(collectionRuns)
    .where(inArray(collectionRuns.status, ["PLANNED", "RUNNING"]))
    .limit(limit);
}

export async function getProviderUsageSince(
  db: Database,
  since: Date,
  provider?: ProviderId,
): Promise<UsageTotals> {
  const conditions = [gte(providerJobs.submittedAt, since)];
  if (provider) conditions.push(eq(providerJobs.provider, provider));

  const rows = await db
    .select({
      records: sql<string>`coalesce(sum(${providerJobs.recordsReturned}), 0)`,
      cost: sql<string>`coalesce(sum(${providerJobs.costEstUsd}), 0)`,
    })
    .from(providerJobs)
    .where(and(...conditions));

  return { recordsUsed: Number(rows[0]?.records ?? "0"), costUsd: rows[0]?.cost ?? "0" };
}
