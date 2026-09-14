/**
 * Operational error log (Phase 5 brief §53-54) — meaningful, unexpected
 * failures only (a programming/invariant error, an unclassified exception
 * during a job phase). Normal, expected conditions (RUNNING, an empty
 * result, a budget skip) are not errors and must not be logged here.
 * `context` must never carry secrets (tokens, Authorization headers,
 * DATABASE_URL) — callers pass only already-sanitized fields.
 */
import { and, eq, gte } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { errorEvents } from "@/db/schema.ts";

export type ErrorSeverity = "INFO" | "WARN" | "ERROR" | "FATAL";

export interface RecordErrorEventParams {
  at: Date;
  scope: string;
  severity: ErrorSeverity;
  message: string;
  context?: Record<string, unknown>;
}

export async function recordErrorEvent(db: Database, params: RecordErrorEventParams): Promise<void> {
  await db.insert(errorEvents).values({
    at: params.at,
    scope: params.scope,
    severity: params.severity,
    message: params.message,
    context: params.context ?? null,
  });
}

/** Whether any row for `scope` was recorded at/after `since` — used both
 * to detect a just-happened failure in an earlier pipeline stage (e.g.
 * "did runAnalytics record an error during this run?") and to dedupe a
 * recurring warning (e.g. the daily dead-man check) so it isn't written
 * again every rerun within the same window. */
export async function hasErrorEventSince(db: Database, scope: string, since: Date): Promise<boolean> {
  const rows = await db.select({ id: errorEvents.id }).from(errorEvents).where(and(eq(errorEvents.scope, scope), gte(errorEvents.at, since))).limit(1);
  return rows.length > 0;
}
