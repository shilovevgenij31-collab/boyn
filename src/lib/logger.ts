/**
 * Minimal structured JSON logger. Vercel Hobby's runtime log retention is
 * short, so this is deliberately not the durable observability story — that
 * lives in the database (collection_runs, provider_jobs, error_events; see
 * docs/IMPLEMENTATION_PLAN.md §24). This logger exists for local debugging
 * and for showing up correctly in `vercel logs` / the dashboard while it's live.
 *
 * Never pass secrets (tokens, full URLs with credentials) as field values.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  runId?: string;
  jobId?: string;
  provider?: string;
  platform?: string;
  durationMs?: number;
  count?: number;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function currentLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return isLogLevel(raw) ? raw : "info";
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) {
    return;
  }
  const entry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields): void => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => write("error", msg, fields),
};
