/**
 * Targeted re-run of ONLY the Bright Data candidate from Phase 1B, after
 * fixing an overly-tight poll timeout (the smoke test's job was still
 * running, not blocked — see POLL_TIMEOUT_MS comment in provider-spike-1b.ts).
 * Reuses the Apify candidate already captured in .spike/results-1b.json
 * rather than re-running it (avoids duplicate Apify spend).
 *
 * Run: `node scripts/provider-spike-1b-retry-bd.ts`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadSpikeCredentials, checkAvailability, collectSecretValues } from "./provider-spike/env.ts";
import { sanitize } from "./provider-spike/sanitize.ts";
import { buildPhase1BSection, upsertPhase1BSection } from "./provider-spike/report-1b.ts";
import { REPO_ROOT, testBrightData } from "./provider-spike-1b.ts";
import type { Phase1BResults } from "./provider-spike/types-1b.ts";

function log(msg: string): void {
  console.log(`[spike-1b-retry-bd] ${msg}`);
}

async function main(): Promise<void> {
  const creds = loadSpikeCredentials(REPO_ROOT);
  const secrets = collectSecretValues(creds);
  const availability = checkAvailability(creds);

  if (!availability.brightdataTiktok.available) {
    throw new Error(`Bright Data TikTok not available: ${availability.brightdataTiktok.detail}`);
  }

  const previous = JSON.parse(
    await readFile(resolve(REPO_ROOT, ".spike", "results-1b.json"), "utf8"),
  ) as Phase1BResults;
  const apifyCandidate = previous.candidates.find((c) => c.provider === "apify");
  if (!apifyCandidate) {
    throw new Error("No prior Apify candidate found in .spike/results-1b.json to preserve");
  }

  const bdCandidate = await testBrightData(creds.brightData!.datasetTikTokPosts!, creds.brightData!.apiToken);

  const results: Phase1BResults = {
    executedAt: new Date().toISOString(),
    queryTerms: previous.queryTerms,
    resultsPerQuery: previous.resultsPerQuery,
    candidates: [bdCandidate, apifyCandidate],
  };

  const spikeDir = resolve(REPO_ROOT, ".spike");
  await mkdir(spikeDir, { recursive: true });
  await writeFile(
    resolve(spikeDir, "results-1b.json"),
    JSON.stringify(sanitize(results, secrets), null, 2) + "\n",
    "utf8",
  );

  const reportPath = resolve(REPO_ROOT, "docs", "PROVIDER_SPIKE.md");
  const existing = await readFile(reportPath, "utf8");
  const section = buildPhase1BSection(results);
  await writeFile(reportPath, upsertPhase1BSection(existing, section), "utf8");

  log(`Bright Data outcome: ${bdCandidate.outcome}, records: ${bdCandidate.recordsDelivered}`);
  log("Updated .spike/results-1b.json and docs/PROVIDER_SPIKE.md");
}

main().catch((error) => {
  console.error(`[spike-1b-retry-bd] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
