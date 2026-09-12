import { eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { collectionRuns, providerJobs } from "@/db/schema.ts";

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
