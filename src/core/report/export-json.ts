/**
 * `trends-YYYY-MM-DD.json` (Phase 7 brief §40): the complete frozen
 * DailyReport, stable and parseable. Every date field is already a
 * plain ISO string (never a Date instance) and every number a plain JS
 * number (never BigInt), so this is a direct, safe serialization.
 */
import type { DailyReport } from "./types.ts";

export function exportJson(report: DailyReport): string {
  return JSON.stringify(report, null, 2);
}
