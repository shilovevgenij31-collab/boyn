/**
 * Local dev helper (Phase 7 brief §75, optional): generate/inspect a
 * DailyReport against the database pointed to by DATABASE_URL, and
 * optionally run a retention dry run. Runtime code (jobs/generate-daily-
 * report.ts, jobs/retention.ts) never depends on this script or the
 * filesystem — this is purely a convenience wrapper that also writes the
 * exports to disk for manual inspection.
 *
 * Usage:
 *   npx tsx scripts/report.ts [--date YYYY-MM-DD] [--market global] [--out ./out] [--retention-dry-run]
 */
import "./load-env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "@/db/client.ts";
import { getEnv } from "@/config/env.ts";
import { FixedClock, systemClock, type Clock } from "@/lib/clock.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { generateDailyReport } from "@/jobs/generate-daily-report.ts";
import { runRetention } from "@/jobs/retention.ts";
import { getDailyReport } from "@/db/repositories/reports.ts";
import { exportMarkdown } from "@/core/report/export-markdown.ts";
import { exportCsv } from "@/core/report/export-csv.ts";
import { exportJson } from "@/core/report/export-json.ts";

function parseArgs(argv: string[]): { date: string | null; market: string; out: string | null; retentionDryRun: boolean } {
  let date: string | null = null;
  let market = getEnv().DEFAULT_MARKET ?? GLOBAL_MARKET;
  let out: string | null = null;
  let retentionDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date") date = argv[++i] ?? null;
    else if (arg === "--market") market = argv[++i] ?? market;
    else if (arg === "--out") out = argv[++i] ?? null;
    else if (arg === "--retention-dry-run") retentionDryRun = true;
  }
  return { date, market, out, retentionDryRun };
}

/** `--date` is a manual/backfill convenience, not the production boundary
 * calculation — it approximates "as of midday UTC on that date" rather
 * than reproducing REPORT_TZ-exact window math, which is unnecessary for
 * local inspection. */
function clockForDate(date: string | null): Clock {
  if (!date) return systemClock;
  return new FixedClock(new Date(`${date}T12:00:00.000Z`));
}

async function main(): Promise<void> {
  const { date, market, out, retentionDryRun } = parseArgs(process.argv.slice(2));
  const db = getDb();
  const clock = clockForDate(date);

  if (retentionDryRun) {
    const result = await runRetention({ db, clock, dryRun: true });
    console.log("[report] retention dry run:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const env = getEnv();
  const result = await generateDailyReport({ db, clock, market, timezone: env.REPORT_TZ ?? "UTC" });
  console.log(`[report] generated ${result.reportDate} (${market}): status=${result.status} written=${result.written}`);
  if (result.partialReasons.length > 0) console.log(`[report] partial reasons: ${result.partialReasons.join(", ")}`);

  const report = await getDailyReport(db, result.reportDate, market);
  if (!report) {
    console.error("[report] generation reported success but the report could not be re-read");
    process.exitCode = 1;
    return;
  }

  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, `trends-${result.reportDate}.md`), exportMarkdown(report), "utf8");
    writeFileSync(resolve(out, `trends-${result.reportDate}.csv`), exportCsv(report), "utf8");
    writeFileSync(resolve(out, `trends-${result.reportDate}.json`), exportJson(report), "utf8");
    console.log(`[report] exports written to ${resolve(out)}`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error("[report] FATAL:", error instanceof Error ? error.message : String(error));
    await closeDb();
    process.exitCode = 1;
  });
