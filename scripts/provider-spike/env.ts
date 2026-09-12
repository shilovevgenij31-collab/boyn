/**
 * Spike-specific credential loading. Deliberately separate from
 * src/config/env.ts (production env schema) rather than importing it: this
 * script is meant to be fully standalone (see docs/IMPLEMENTATION_PLAN.md
 * §28 Phase 1 scope) and run directly via `node scripts/provider-spike.ts`,
 * outside the Next.js app's module graph.
 *
 * Never logs or returns credential values in any structure that gets
 * printed/written to disk as-is — callers must go through sanitize.ts before
 * persisting anything that might contain a token.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_LOCAL_CANDIDATES = [".env.local", ".env"];

/** Minimal KEY=VALUE parser (no dependency). Only fills in vars not already
 * set in process.env, matching dotenv's usual precedence. */
function loadDotEnvFilesIntoProcessEnv(repoRoot: string): void {
  for (const filename of ENV_LOCAL_CANDIDATES) {
    const path = resolve(repoRoot, filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export interface BrightDataCredentials {
  apiToken: string;
  datasetTikTokPosts?: string;
  datasetInstagramPosts?: string;
}

export interface ApifyCredentials {
  apiToken: string;
  actorTikTok?: string;
  actorInstagram?: string;
}

export interface SpikeCredentials {
  brightData: BrightDataCredentials | null;
  apify: ApifyCredentials | null;
}

/** True set of secret string values currently loaded, used by sanitize.ts to
 * redact them wherever they appear in captured output. Never printed itself. */
export function collectSecretValues(creds: SpikeCredentials): string[] {
  const secrets: string[] = [];
  if (creds.brightData) secrets.push(creds.brightData.apiToken);
  if (creds.apify) secrets.push(creds.apify.apiToken);
  return secrets.filter((s) => s.length > 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Loads spike credentials from process.env, first merging in .env.local/
 * .env from the repo root if present (repoRoot defaults to two levels up
 * from this file: scripts/provider-spike/env.ts -> repo root). */
export function loadSpikeCredentials(repoRoot = resolve(import.meta.dirname, "../..")): SpikeCredentials {
  loadDotEnvFilesIntoProcessEnv(repoRoot);

  const brightDataToken = nonEmpty(process.env.BRIGHTDATA_API_TOKEN);
  const brightData: BrightDataCredentials | null = brightDataToken
    ? {
        apiToken: brightDataToken,
        datasetTikTokPosts: nonEmpty(process.env.BRIGHTDATA_DATASET_TIKTOK_POSTS),
        datasetInstagramPosts: nonEmpty(process.env.BRIGHTDATA_DATASET_INSTAGRAM_POSTS),
      }
    : null;

  const apifyToken = nonEmpty(process.env.APIFY_API_TOKEN);
  const apify: ApifyCredentials | null = apifyToken
    ? {
        apiToken: apifyToken,
        actorTikTok: nonEmpty(process.env.APIFY_ACTOR_TIKTOK),
        actorInstagram: nonEmpty(process.env.APIFY_ACTOR_INSTAGRAM),
      }
    : null;

  return { brightData, apify };
}

export type BlockReason =
  | "NO_API_TOKEN"
  | "NO_DATASET_ID"
  | "NO_ACTOR_ID";

export interface Availability {
  available: boolean;
  reason?: BlockReason;
  detail: string;
}

/** Human-readable, per-combination availability check — used to decide
 * whether a network call is even attempted, and to explain BLOCKED cells in
 * the report without guessing. */
export function checkAvailability(
  creds: SpikeCredentials,
): Record<
  "brightdataTiktok" | "brightdataInstagram" | "apifyTiktok" | "apifyInstagram",
  Availability
> {
  const bd = creds.brightData;
  const af = creds.apify;

  const brightdataTiktok: Availability = !bd
    ? { available: false, reason: "NO_API_TOKEN", detail: "BRIGHTDATA_API_TOKEN is not set" }
    : !bd.datasetTikTokPosts
      ? {
          available: false,
          reason: "NO_DATASET_ID",
          detail: "BRIGHTDATA_DATASET_TIKTOK_POSTS is not set",
        }
      : { available: true, detail: "credentials present" };

  const brightdataInstagram: Availability = !bd
    ? { available: false, reason: "NO_API_TOKEN", detail: "BRIGHTDATA_API_TOKEN is not set" }
    : !bd.datasetInstagramPosts
      ? {
          available: false,
          reason: "NO_DATASET_ID",
          detail: "BRIGHTDATA_DATASET_INSTAGRAM_POSTS is not set",
        }
      : { available: true, detail: "credentials present" };

  const apifyTiktok: Availability = !af
    ? { available: false, reason: "NO_API_TOKEN", detail: "APIFY_API_TOKEN is not set" }
    : !af.actorTikTok
      ? { available: false, reason: "NO_ACTOR_ID", detail: "APIFY_ACTOR_TIKTOK is not set" }
      : { available: true, detail: "credentials present" };

  const apifyInstagram: Availability = !af
    ? { available: false, reason: "NO_API_TOKEN", detail: "APIFY_API_TOKEN is not set" }
    : !af.actorInstagram
      ? { available: false, reason: "NO_ACTOR_ID", detail: "APIFY_ACTOR_INSTAGRAM is not set" }
      : { available: true, detail: "credentials present" };

  return { brightdataTiktok, brightdataInstagram, apifyTiktok, apifyInstagram };
}
