/**
 * `result_views` persistence (Phase 8 brief §20-21, §60): a live ranking
 * (`/rising`, `/tiktok`, a category filter, ...) is frozen the moment the
 * command runs — every page of pagination reads that SAME frozen list,
 * never a re-query, so analytics updating in the background can never
 * reorder page 2 beneath page 1 mid-browse.
 */
import { eq, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Database } from "@/db/client.ts";
import { resultViews } from "@/db/schema.ts";
import type { ReportItem } from "@/core/report/types.ts";

/** Short, cryptographically-safe, callback_data-friendly id (brief §60) —
 * base64url has no `:` in its alphabet, so it never collides with the
 * `pg:{viewId}:{page}` delimiter. 9 random bytes -> 12 chars. */
export function generateResultViewId(): string {
  return randomBytes(9).toString("base64url");
}

export interface ResultViewParams {
  kind: string;
  /** Rendered once at creation time and replayed verbatim on every later
   * page/callback (brief §21) — a callback has no other way to recover
   * the exact header a command originally showed (e.g. a PARTIAL badge,
   * "Data as of HH:MM") without re-running report/analytics logic. */
  headerText: string;
  /** Free-form provenance (platform/category/mode/...) — informational
   * only, never read back to decide ranking (the frozen `items` already
   * settled that). */
  extra?: Record<string, unknown>;
  items: ReportItem[];
  createdAt: Date;
  ttlDays: number;
}

export async function createResultView(db: Database, params: ResultViewParams): Promise<string> {
  const id = generateResultViewId();
  const expiresAt = new Date(params.createdAt.getTime() + params.ttlDays * 24 * 3_600_000);
  await db.insert(resultViews).values({
    id,
    kind: params.kind,
    params: { headerText: params.headerText, ...(params.extra ?? {}) },
    items: params.items,
    createdAt: params.createdAt,
    expiresAt,
  });
  return id;
}

export interface StoredResultView {
  kind: string;
  headerText: string;
  items: ReportItem[];
  createdAt: Date;
  expiresAt: Date;
}

/** `null` both when the id doesn't exist and when it has expired
 * (brief §57's "check expiration") — callers don't need to distinguish
 * the two; either way the answer is "rerun the command". */
export async function getResultView(db: Database, id: string, now: Date): Promise<StoredResultView | null> {
  const rows = await db.select().from(resultViews).where(eq(resultViews.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  const headerText = typeof row.params?.headerText === "string" ? row.params.headerText : "";
  return { kind: row.kind, headerText, items: row.items as ReportItem[], createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/** How many non-expired views currently exist — exposed for tests only
 * (retention's own sweep, not this repository, is the production cleanup
 * path). */
export async function countLiveResultViews(db: Database, now: Date): Promise<number> {
  const rows = await db.select({ id: resultViews.id }).from(resultViews).where(gt(resultViews.expiresAt, now));
  return rows.length;
}
