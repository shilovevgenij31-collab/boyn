import { z } from "zod";

/**
 * Environment schema. Phase 0 must boot with ZERO of these set — every
 * future-phase variable is `.optional()`. What we DO enforce, always: any
 * value that IS supplied must be well-formed. This lets local dev and health
 * checks run before we have Telegram/Neon/Bright Data/Apify/OpenRouter
 * credentials, while still catching typos in whatever is configured.
 *
 * A later phase that actually needs a subsystem (DB, Telegram, a provider)
 * is responsible for asserting its own required fields are present at the
 * point of use — see docs/IMPLEMENTATION_PLAN.md §27 for the full variable
 * list and which phase introduces each group.
 */

const numericIdString = z.string().regex(/^-?\d+$/, "must be a numeric id");
const positiveNumberString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number");
const timeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");
const telegramSecretToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,256}$/, "must be 1-256 chars of A-Z a-z 0-9 _ -");
const providerId = z.enum(["brightdata", "apify"]);

const envSchema = z.object({
  // ---- Core app -------------------------------------------------------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_BASE_URL: z.string().url().optional(),

  // ---- Database (Neon) — Phase 3 ---------------------------------------
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_UNPOOLED: z.string().min(1).optional(),

  // ---- Telegram — Phase 8 ----------------------------------------------
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: telegramSecretToken.optional(),
  ADMIN_TELEGRAM_ID: numericIdString.optional(),
  // Comma-separated list of numeric Telegram user ids; parsed downstream.
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  TELEGRAM_REPORT_CHAT_ID: z.string().optional(),

  // ---- Scheduling / webhooks — Phase 5 ----------------------------------
  CRON_SECRET: z.string().min(1).optional(),
  PROVIDER_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ---- Social data providers — Phase 4 (routing decided in Phase 1) -----
  BRIGHTDATA_API_TOKEN: z.string().min(1).optional(),
  BRIGHTDATA_DATASET_TIKTOK_POSTS: z.string().min(1).optional(),
  BRIGHTDATA_DATASET_INSTAGRAM_POSTS: z.string().min(1).optional(),

  APIFY_API_TOKEN: z.string().min(1).optional(),
  APIFY_ACTOR_TIKTOK: z.string().min(1).optional(),
  APIFY_ACTOR_INSTAGRAM: z.string().min(1).optional(),

  PROVIDER_TIKTOK_PRIMARY: providerId.optional(),
  PROVIDER_TIKTOK_FALLBACK: providerId.optional(),
  PROVIDER_INSTAGRAM_PRIMARY: providerId.optional(),
  PROVIDER_INSTAGRAM_FALLBACK: providerId.optional(),
  PROVIDER_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/, "must be a 2-letter uppercase ISO country code")
    .optional(),

  // ---- Market / crawl budget --------------------------------------------
  // "global" is a real market value, not a stand-in for "unconfigured".
  // See docs/IMPLEMENTATION_PLAN.md ADR-020.
  DEFAULT_MARKET: z.string().min(1).default("global"),

  BUDGET_PROFILE: z.enum(["FREE", "LEAN", "STANDARD"]).default("LEAN"),
  BUDGET_MONTHLY_USD_MAX: positiveNumberString.optional(),
  BUDGET_APIFY_MONTHLY_USD_MAX: positiveNumberString.optional(),

  // ---- Reporting ----------------------------------------------------------
  REPORT_TZ: z.string().min(1).optional(),
  REPORT_LOCAL_TIME: timeHHMM.optional(),

  // ---- Optional AI (OpenRouter) — never required, see ADR-002 -------------
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  // Comma-separated ordered list of free model ids; parsed downstream.
  OPENROUTER_MODELS: z.string().optional(),
  AI_AUTO_DAILY: z.enum(["true", "false"]).optional(),
  AI_TIMEOUT_MS: z.string().regex(/^\d+$/, "must be an integer number of milliseconds").optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses and validates the given source (defaults to `process.env`).
 * Throws a single readable Error listing every problem found, rather than
 * failing on the first one. Accepts a plain record (not `NodeJS.ProcessEnv`)
 * so tests can pass a minimal, partial object without satisfying every
 * built-in Node env var. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/** Cached accessor for production code paths — parses once per process. */
export function getEnv(): Env {
  if (!cached) {
    cached = loadEnv();
  }
  return cached;
}

/** Test-only: clears the cache so a test can call getEnv() again after
 * mutating process.env. Not for use in application code. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
