/**
 * Manual smoke-test CLI for the production provider adapters (Phase 4).
 * Runs exactly ONE real submit -> poll -> fetch cycle against a real
 * vendor with a small result limit — for verifying the production
 * adapters against a live account, not for automated test runs (offline
 * tests use FixtureProvider) and not part of the app's runtime.
 *
 * Usage (via tsx, same pattern as scripts/db-seed.ts):
 *   npx tsx scripts/provider-smoke.ts --provider=apify --platform=tiktok --operation=discovery --query=cosplay --limit=5
 *   npx tsx scripts/provider-smoke.ts --provider=apify --platform=instagram --operation=discovery --query=cosplay --limit=5
 *   npx tsx scripts/provider-smoke.ts --provider=apify --platform=tiktok --operation=refresh --url=https://www.tiktok.com/@u/video/123
 *   npx tsx scripts/provider-smoke.ts --provider=brightdata --platform=tiktok --operation=discovery --query=cosplay --limit=5
 *
 * Never prints API tokens, Authorization headers, or raw dashboard URLs
 * with secrets embedded — only sanitized status/results (Phase 4 brief:
 * never log secrets).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEnv } from "@/config/env.ts";
import { normalizeQueryTerm } from "@/core/normalize/query.ts";
import { ApifyProvider } from "@/providers/apify/provider.ts";
import { BrightDataProvider } from "@/providers/brightdata/provider.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderJobState, SocialDataProvider } from "@/providers/provider.ts";
import { isProviderError } from "@/providers/errors.ts";

/** Unlike Next.js (which auto-loads .env.local), a script run via `tsx`
 * doesn't — so mirror the minimal loader scripts/provider-spike/env.ts
 * already uses (no dependency, only fills vars not already set). */
function loadDotEnvLocalIntoProcessEnv(): void {
  const path = resolve(import.meta.dirname, "..", ".env.local");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

interface CliArgs {
  provider: "apify" | "brightdata";
  platform: Platform;
  operation: "discovery" | "refresh";
  query?: string;
  url?: string;
  limit: number;
  maxPolls: number;
  pollIntervalMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) flags.set(match[1], match[2]);
  }

  const provider = flags.get("provider");
  const platform = flags.get("platform");
  const operation = flags.get("operation");
  if (provider !== "apify" && provider !== "brightdata") {
    throw new Error("--provider must be 'apify' or 'brightdata'");
  }
  if (platform !== "tiktok" && platform !== "instagram") {
    throw new Error("--platform must be 'tiktok' or 'instagram'");
  }
  if (operation !== "discovery" && operation !== "refresh") {
    throw new Error("--operation must be 'discovery' or 'refresh'");
  }

  const limit = Number(flags.get("limit") ?? "5");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("--limit must be an integer between 1 and 20 (conservative smoke-test cap)");
  }

  return {
    provider,
    platform,
    operation,
    query: flags.get("query"),
    url: flags.get("url"),
    limit,
    maxPolls: Number(flags.get("max-polls") ?? "20"),
    pollIntervalMs: Number(flags.get("poll-interval-ms") ?? "5000"),
  };
}

function buildProvider(args: CliArgs): SocialDataProvider {
  const env = getEnv();
  if (args.provider === "apify") {
    if (!env.APIFY_API_TOKEN || !env.APIFY_ACTOR_TIKTOK || !env.APIFY_ACTOR_INSTAGRAM) {
      throw new Error("APIFY_API_TOKEN / APIFY_ACTOR_TIKTOK / APIFY_ACTOR_INSTAGRAM must be set in the environment");
    }
    return new ApifyProvider({
      apiToken: env.APIFY_API_TOKEN,
      actorTikTok: env.APIFY_ACTOR_TIKTOK,
      actorInstagram: env.APIFY_ACTOR_INSTAGRAM,
    });
  }
  if (!env.BRIGHTDATA_API_TOKEN || !env.BRIGHTDATA_DATASET_TIKTOK_POSTS) {
    throw new Error("BRIGHTDATA_API_TOKEN / BRIGHTDATA_DATASET_TIKTOK_POSTS must be set in the environment");
  }
  return new BrightDataProvider({
    apiToken: env.BRIGHTDATA_API_TOKEN,
    datasetTikTokPosts: env.BRIGHTDATA_DATASET_TIKTOK_POSTS,
  });
}

/** Strips anything that could be a token/secret from a string before it's
 * ever printed — belt-and-suspenders on top of providerFetch's own
 * redaction (src/providers/http.ts), since this script prints vendor
 * errors verbatim otherwise. */
function sanitize(text: string): string {
  return text
    .replace(/([?&](?:token|api_key|apikey|key|secret)=)[^&\s"]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_.\-]+/gi, "Bearer [REDACTED]");
}

async function pollUntilReady(
  provider: SocialDataProvider,
  externalJobId: string,
  args: CliArgs,
): Promise<void> {
  let state: ProviderJobState = "SUBMITTED";
  for (let attempt = 0; attempt < args.maxPolls; attempt++) {
    const status = await provider.getStatus(externalJobId);
    state = status.state;
    console.log(`[provider-smoke] poll ${attempt + 1}/${args.maxPolls}: state=${state} rawVendorStatus=${sanitize(status.rawVendorStatus)}`);
    if (state === "READY" || state === "FAILED") return;
    await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
  }
  throw new Error(`job did not reach a terminal state within ${args.maxPolls} polls (last state: ${state})`);
}

async function main(): Promise<void> {
  loadDotEnvLocalIntoProcessEnv();
  const args = parseArgs(process.argv.slice(2));
  const provider = buildProvider(args);

  console.log(`[provider-smoke] provider=${provider.id} platform=${args.platform} operation=${args.operation} limit=${args.limit}`);
  console.log(`[provider-smoke] capabilities: ${JSON.stringify(provider.capabilities()[args.platform])}`);

  const submitted =
    args.operation === "discovery"
      ? await (async () => {
          if (!args.query) throw new Error("--query is required for discovery");
          const normalized = normalizeQueryTerm(args.query);
          if (!normalized) throw new Error(`--query "${args.query}" failed normalization`);
          return provider.submitDiscovery({
            platform: args.platform,
            market: "global",
            queries: [{ query: normalized }],
            limitPerQuery: args.limit,
          });
        })()
      : await (async () => {
          if (!args.url) throw new Error("--url is required for refresh");
          return provider.submitRefresh({
            platform: args.platform,
            posts: [{ externalId: "smoke-test", canonicalUrl: args.url }],
          });
        })();

  console.log(`[provider-smoke] submitted: externalJobId=${submitted.externalJobId} submittedAt=${submitted.submittedAt.toISOString()}`);

  await pollUntilReady(provider, submitted.externalJobId, args);

  const finalStatus = await provider.getStatus(submitted.externalJobId);
  if (finalStatus.state !== "READY") {
    console.log(`[provider-smoke] job did not succeed (state=${finalStatus.state}), not fetching results`);
    return;
  }

  const page = await provider.fetchResults(submitted.externalJobId);
  console.log(`[provider-smoke] fetched ${page.items.length} item(s), truncated=${page.truncated}, nextCursor=${page.nextCursor ?? "null"}`);
  for (const [i, item] of page.items.entries()) {
    console.log(`[provider-smoke] item[${i}]: ${sanitize(JSON.stringify(item)).slice(0, 300)}`);
  }
}

main().catch((error) => {
  if (isProviderError(error)) {
    console.error(`[provider-smoke] FATAL ProviderError: code=${error.code} provider=${error.provider} operation=${error.operation} message=${sanitize(error.message)}`);
  } else {
    console.error(`[provider-smoke] FATAL: ${sanitize(error instanceof Error ? error.message : String(error))}`);
  }
  process.exitCode = 1;
});
