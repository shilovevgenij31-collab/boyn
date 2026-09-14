/**
 * Retention job entry point (Phase 7 brief §35-38): a thin Clock-driven
 * wrapper around the repository sweep, kept separate so run-daily.ts (and
 * a future manual/CLI trigger) has one obvious place to call from without
 * reaching into src/db/repositories directly.
 */
import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import { runRetentionSweep, type RetentionResult } from "@/db/repositories/retention.ts";

export interface RunRetentionParams {
  db: Database;
  clock: Clock;
  dryRun?: boolean;
}

export async function runRetention(params: RunRetentionParams): Promise<RetentionResult> {
  return runRetentionSweep(params.db, params.clock.now(), params.dryRun ?? false);
}
