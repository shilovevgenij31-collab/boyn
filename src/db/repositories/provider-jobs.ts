/**
 * Provider-job lifecycle persistence (Phase 5 brief §12-23): planning,
 * durable leases, and the state transitions a job moves through —
 * PENDING -> SUBMITTED -> RUNNING -> READY -> INGESTED, or -> FAILED /
 * TIMED_OUT at any point. All lease acquisition uses an atomic
 * conditional UPDATE (WHERE status=expected AND lease free) rather than a
 * SELECT-then-UPDATE, so two overlapping tick invocations racing for the
 * same row never both "win" (Phase 5 brief §13-15) — Postgres serializes
 * concurrent UPDATEs on the same row, and only the one whose WHERE clause
 * still matches after the other commits succeeds.
 */
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { providerJobs } from "@/db/schema.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderId } from "@/core/domain/provider.ts";

export type JobStatus = "PENDING" | "SUBMITTED" | "RUNNING" | "READY" | "INGESTED" | "FAILED" | "TIMED_OUT";
export type JobType = "HASHTAG_DISCOVERY" | "POST_REFRESH";

export interface PlanProviderJobParams {
  collectionRunId: number;
  provider: ProviderId;
  platform: Platform;
  jobType: JobType;
  /** Safe, secret-free query/URL metadata only — never a raw provider
   * request body (which could echo back sensitive account config). */
  input: Record<string, unknown>;
}

/** Inserts a new PENDING job row — the durable "intent to submit" record
 * that must exist before any paid provider call (Phase 5 brief §12): if
 * the process crashes between this insert and the actual HTTP call, the
 * row is still PENDING and gets picked up (and actually submitted for the
 * first time) by a later tick's submit phase, rather than being lost. */
export async function planProviderJob(db: Database, params: PlanProviderJobParams): Promise<number> {
  const rows = await db
    .insert(providerJobs)
    .values({
      collectionRunId: params.collectionRunId,
      provider: params.provider,
      platform: params.platform,
      jobType: params.jobType,
      input: params.input,
      status: "PENDING",
    })
    .returning({ id: providerJobs.id });
  const row = rows[0];
  if (!row) throw new Error("planProviderJob: insert returned no row");
  return row.id;
}

export interface ProviderJobRow {
  id: number;
  collectionRunId: number;
  provider: ProviderId;
  platform: Platform;
  jobType: JobType;
  externalJobId: string | null;
  input: Record<string, unknown> | null;
  status: JobStatus;
  attempts: number;
  submittedAt: Date | null;
}

export async function getProviderJobById(db: Database, id: number): Promise<ProviderJobRow | null> {
  const rows = await db
    .select({
      id: providerJobs.id,
      collectionRunId: providerJobs.collectionRunId,
      provider: providerJobs.provider,
      platform: providerJobs.platform,
      jobType: providerJobs.jobType,
      externalJobId: providerJobs.externalJobId,
      input: providerJobs.input,
      status: providerJobs.status,
      attempts: providerJobs.attempts,
      submittedAt: providerJobs.submittedAt,
    })
    .from(providerJobs)
    .where(eq(providerJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Atomically claims a lease on a row currently in `expectedStatus` whose
 * previous lease (if any) has expired. Returns true iff this call won the
 * race. */
async function acquireLease(
  db: Database,
  id: number,
  expectedStatus: JobStatus,
  now: Date,
  leaseUntil: Date,
): Promise<boolean> {
  const rows = await db
    .update(providerJobs)
    .set({ leaseUntil })
    .where(
      and(
        eq(providerJobs.id, id),
        eq(providerJobs.status, expectedStatus),
        or(isNull(providerJobs.leaseUntil), lt(providerJobs.leaseUntil, now)),
      ),
    )
    .returning({ id: providerJobs.id });
  return rows.length > 0;
}

export async function acquireSubmitLease(db: Database, id: number, now: Date, leaseUntil: Date): Promise<boolean> {
  return acquireLease(db, id, "PENDING", now, leaseUntil);
}

/** Oldest-planned-first (Phase 5 brief §48 fairness), lease free. */
export async function getPendingJobIds(db: Database, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(and(eq(providerJobs.status, "PENDING"), or(isNull(providerJobs.leaseUntil), lt(providerJobs.leaseUntil, now))))
    .orderBy(asc(providerJobs.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Pollable = SUBMITTED or RUNNING, due (next_poll_at <= now), lease free. */
export async function getPollableJobIds(db: Database, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(
      and(
        inArray(providerJobs.status, ["SUBMITTED", "RUNNING"]),
        or(isNull(providerJobs.nextPollAt), lte(providerJobs.nextPollAt, now)),
        or(isNull(providerJobs.leaseUntil), lt(providerJobs.leaseUntil, now)),
      ),
    )
    .orderBy(sql`${providerJobs.nextPollAt} nulls first`)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function acquirePollLease(
  db: Database,
  id: number,
  currentStatus: "SUBMITTED" | "RUNNING",
  now: Date,
  leaseUntil: Date,
): Promise<boolean> {
  return acquireLease(db, id, currentStatus, now, leaseUntil);
}

/** Ready-to-ingest = READY, lease free. Oldest-completed-first, so a
 * long-idle READY job isn't starved by newer ones (Phase 5 brief §48). */
export async function getIngestableJobIds(db: Database, now: Date, limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(and(eq(providerJobs.status, "READY"), or(isNull(providerJobs.leaseUntil), lt(providerJobs.leaseUntil, now))))
    .orderBy(sql`${providerJobs.completedAt} nulls first`)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function acquireIngestLease(db: Database, id: number, now: Date, leaseUntil: Date): Promise<boolean> {
  return acquireLease(db, id, "READY", now, leaseUntil);
}

export interface MarkSubmittedParams {
  externalJobId: string;
  submittedAt: Date;
  httpMs: number;
  nextPollAt: Date;
  status: "SUBMITTED" | "RUNNING";
  /** An unguessable per-job token (Phase 5 brief §44), stored now so the
   * webhook route can look this row up later if/when a provider's
   * submission call is ever extended to register a webhook URL carrying
   * it — no adapter does that yet (unverified), so this token currently
   * never actually gets used inbound, but the row is ready for it. */
  webhookToken: string;
}

/** Records a successful provider submission and releases the lease —
 * done as one update so the row is never left mid-transition (Phase 5
 * brief §19). */
export async function markJobSubmitted(db: Database, id: number, params: MarkSubmittedParams): Promise<void> {
  await db
    .update(providerJobs)
    .set({
      externalJobId: params.externalJobId,
      status: params.status,
      submittedAt: params.submittedAt,
      httpMs: params.httpMs,
      nextPollAt: params.nextPollAt,
      webhookToken: params.webhookToken,
      attempts: sql`${providerJobs.attempts} + 1`,
      leaseUntil: null,
    })
    .where(eq(providerJobs.id, id));
}

export async function markJobSubmitFailed(db: Database, id: number, error: string, now: Date): Promise<void> {
  await db
    .update(providerJobs)
    .set({
      status: "FAILED",
      error,
      completedAt: now,
      attempts: sql`${providerJobs.attempts} + 1`,
      leaseUntil: null,
    })
    .where(eq(providerJobs.id, id));
}

/** Releases a row's lease without changing its status — used whenever a
 * phase decides NOT to change a job's state this pass (budget/circuit
 * denial, a poll request that itself failed) but wants the row available
 * for another attempt without waiting out the full lease duration. */
export async function releaseLease(db: Database, id: number): Promise<void> {
  await db.update(providerJobs).set({ leaseUntil: null }).where(eq(providerJobs.id, id));
}

/** Budget/circuit denial at submit time is not a provider failure (Phase 5
 * brief §16) — the row is left PENDING (not FAILED) so a later tick, once
 * budget/circuit conditions change, can pick it up again. Lease is
 * released immediately so that retry isn't blocked by this tick's lease. */
export async function releaseSubmitLeaseWithoutAttempt(db: Database, id: number): Promise<void> {
  await releaseLease(db, id);
}

export interface MarkPolledParams {
  status: "RUNNING" | "READY" | "FAILED" | "TIMED_OUT";
  now: Date;
  nextPollAt?: Date | null;
  error?: string | null;
}

export async function markJobPolled(db: Database, id: number, params: MarkPolledParams): Promise<void> {
  const terminal = params.status === "READY" || params.status === "FAILED" || params.status === "TIMED_OUT";
  await db
    .update(providerJobs)
    .set({
      status: params.status,
      nextPollAt: params.nextPollAt ?? null,
      error: params.error ?? null,
      completedAt: terminal ? params.now : null,
      leaseUntil: null,
    })
    .where(eq(providerJobs.id, id));
}

export interface MarkIngestedParams {
  recordsReturned: number;
  recordsQuarantined: number;
  ingestedAt: Date;
}

export async function markJobIngested(db: Database, id: number, params: MarkIngestedParams): Promise<void> {
  await db
    .update(providerJobs)
    .set({
      status: "INGESTED",
      recordsReturned: params.recordsReturned,
      recordsQuarantined: params.recordsQuarantined,
      ingestedAt: params.ingestedAt,
      leaseUntil: null,
    })
    .where(eq(providerJobs.id, id));
}

export async function releaseIngestLease(db: Database, id: number): Promise<void> {
  await releaseLease(db, id);
}

/**
 * Webhook support (Phase 5 brief §43-45): looks up a job by its
 * unguessable token, scoped to the claimed provider so a token can never
 * be replayed against a different vendor's job. Only SUBMITTED/RUNNING
 * jobs are pollable-nudge candidates — a job already READY/terminal has
 * nothing left to accelerate.
 */
export async function getJobByWebhookToken(db: Database, provider: ProviderId, webhookToken: string): Promise<ProviderJobRow | null> {
  const rows = await db
    .select({
      id: providerJobs.id,
      collectionRunId: providerJobs.collectionRunId,
      provider: providerJobs.provider,
      platform: providerJobs.platform,
      jobType: providerJobs.jobType,
      externalJobId: providerJobs.externalJobId,
      input: providerJobs.input,
      status: providerJobs.status,
      attempts: providerJobs.attempts,
      submittedAt: providerJobs.submittedAt,
    })
    .from(providerJobs)
    .where(and(eq(providerJobs.provider, provider), eq(providerJobs.webhookToken, webhookToken)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A webhook notification never carries trusted status (Phase 5 brief
 * §44: "never trust webhook body blindly") — this only brings the next
 * poll forward to "now", so the very next tick's poll phase re-derives
 * status from the provider's own status API, the one trusted source.
 * A no-op if the job isn't currently pollable (already READY/terminal).
 */
export async function nudgeJobPollNow(db: Database, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(providerJobs)
    .set({ nextPollAt: now })
    .where(and(eq(providerJobs.id, id), inArray(providerJobs.status, ["SUBMITTED", "RUNNING"])))
    .returning({ id: providerJobs.id });
  return rows.length > 0;
}

export async function getJobsForCollectionRun(db: Database, collectionRunId: number): Promise<ProviderJobRow[]> {
  return db
    .select({
      id: providerJobs.id,
      collectionRunId: providerJobs.collectionRunId,
      provider: providerJobs.provider,
      platform: providerJobs.platform,
      jobType: providerJobs.jobType,
      externalJobId: providerJobs.externalJobId,
      input: providerJobs.input,
      status: providerJobs.status,
      attempts: providerJobs.attempts,
      submittedAt: providerJobs.submittedAt,
    })
    .from(providerJobs)
    .where(eq(providerJobs.collectionRunId, collectionRunId));
}
