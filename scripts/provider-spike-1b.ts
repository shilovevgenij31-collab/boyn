/**
 * Phase 1B — TikTok Discovery Rescue.
 *
 * Narrow follow-up to scripts/provider-spike.ts: Phase 1 rejected Apify
 * hashtag-mode TikTok discovery for staleness (median age 534.3h, 3.3%
 * <24h). This script tests ONLY the two remaining candidates:
 *   A. Bright Data TikTok discover_by=keyword (re-tested: the account was
 *      inactive during Phase 1; a smoke test first checks whether that's
 *      still true before spending the full budget).
 *   B. Apify clockworks/tiktok-scraper SEARCH mode (searchQueries +
 *      searchSection=/video + videoSearchSorting=LATEST +
 *      videoSearchDateFilter=PAST_24_HOURS) — not the rejected hashtag mode.
 *
 * Instagram is NOT retested (already resolved in Phase 1: Apify primary,
 * gate PASSED). This script never touches Instagram.
 *
 * Writes results into the EXISTING docs/PROVIDER_SPIKE.md under a
 * dedicated "Phase 1B" section (upsertPhase1BSection), leaving the
 * original Phase 1 content untouched. Also writes .spike/results-1b.json
 * (gitignored) and up to 5 sanitized fixtures per tested candidate.
 *
 * Run: `node scripts/provider-spike-1b.ts`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { checkAvailability, collectSecretValues, loadSpikeCredentials } from "./provider-spike/env.ts";
import { sanitize } from "./provider-spike/sanitize.ts";
import { computeFreshnessStats } from "./provider-spike/freshness.ts";
import { computeFieldCoverage } from "./provider-spike/coverage.ts";
import { computeRelevance } from "./provider-spike/relevance.ts";
import { FIELD_CANDIDATES, firstPresent, getPath, parseTimestamp } from "./provider-spike/extract.ts";
import { saveFixtures } from "./provider-spike/fixtures.ts";
import { buildPhase1BSection, upsertPhase1BSection } from "./provider-spike/report-1b.ts";
import * as brightdata from "./provider-spike/brightdata.ts";
import * as apify from "./provider-spike/apify.ts";
import type { SupportVerdict } from "./provider-spike/types.ts";
import type { Phase1BCandidateResult, Phase1BResults } from "./provider-spike/types-1b.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const QUERY_TERMS = ["cosplay", "gaming", "ps5"];
export const RESULTS_PER_QUERY = 20;
const POLL_INTERVAL_MS = 10_000;
// Empirically Bright Data's /scrape can take 3-6+ minutes for a small
// keyword-discovery job (observed 195s and 369s for the same 1-keyword,
// limit-5 smoke request on separate calls) — 4 minutes was too tight and
// produced a false BLOCKED verdict on a job that was, in fact, still
// running and later succeeded. Apify calls finish in well under this, so a
// shared generous ceiling costs nothing there.
const POLL_TIMEOUT_MS = 10 * 60_000;

function log(msg: string): void {
  console.log(`[spike-1b] ${msg}`);
}

function classifyUrl(url: string): { looksCanonical: boolean; host: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    return { looksCanonical: host === "tiktok.com", host };
  } catch {
    return { looksCanonical: false, host: null };
  }
}

function countDuplicateIds(records: Record<string, unknown>[], idCandidates: string[]): number {
  const seen = new Set<unknown>();
  let dup = 0;
  for (const r of records) {
    const idValue = firstPresent(r, idCandidates).value;
    if (idValue !== undefined) {
      if (seen.has(idValue)) dup++;
      seen.add(idValue);
    }
  }
  return dup;
}

function assessAttribution(
  records: Record<string, unknown>[],
  explicitCandidates: string[],
): { verdict: SupportVerdict; note: string } {
  if (records.length === 0) return { verdict: "NOT_TESTED", note: "no records returned" };
  const withExplicit = records.filter((r) => firstPresent(r, explicitCandidates).field !== null).length;
  if (withExplicit === records.length) {
    return { verdict: "SUPPORTED", note: `every record carries an attribution field (checked: ${explicitCandidates.join(", ")})` };
  }
  if (withExplicit > 0) {
    return { verdict: "AMBIGUOUS", note: `${withExplicit}/${records.length} records carry an attribution field` };
  }
  return { verdict: "NOT_SUPPORTED", note: `no attribution field found (checked: ${explicitCandidates.join(", ")})` };
}

function analyzeRecords(params: {
  provider: "brightdata" | "apify";
  records: Record<string, unknown>[];
  attributionCandidates: string[];
}): Pick<
  Phase1BCandidateResult,
  | "freshness"
  | "fieldCoverage"
  | "viewsMetricNote"
  | "relevance"
  | "duplicateIdCount"
  | "urlFinding"
  | "idFinding"
  | "multiQueryAttribution"
  | "multiQueryNote"
  | "edgeCaseNotes"
> {
  const { provider, records, attributionCandidates } = params;
  const key = `${provider}_tiktok` as const;
  const candidates = FIELD_CANDIDATES[key];

  const publishedDates = records.map((r) => parseTimestamp(firstPresent(r, candidates.publishedAt).value));
  const freshness = computeFreshnessStats(publishedDates, new Date());

  const coverageFields = [
    ...candidates.id,
    ...candidates.url,
    ...candidates.username,
    ...candidates.publishedAt,
    ...candidates.views,
    ...candidates.likes,
    ...candidates.comments,
    ...candidates.shares,
    ...candidates.caption,
    ...candidates.hashtags,
    ...candidates.musicTitle,
  ];
  const fieldCoverage = computeFieldCoverage(records, coverageFields);

  const viewMatches = records.map((r) => firstPresent(r, candidates.views));
  const viewFieldsSeen = [...new Set(viewMatches.map((m) => m.field).filter((f): f is string => f !== null))];
  const viewsMetricNote =
    viewFieldsSeen.length === 0
      ? "no configured view-count field present on any record"
      : viewFieldsSeen.length === 1
        ? `consistently \`${viewFieldsSeen[0]}\``
        : `INCONSISTENT: saw ${viewFieldsSeen.join(", ")}`;

  const captions = records.map((r) => {
    const v = firstPresent(r, candidates.caption).value;
    return typeof v === "string" ? v : null;
  });
  const hashtagArrays = records.map((r) => {
    const v = getPath(r, "hashtags");
    return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : null;
  });
  const relevance = computeRelevance(captions, hashtagArrays, QUERY_TERMS);

  const duplicateIdCount = countDuplicateIds(records, candidates.id);

  const first = records[0];
  const firstUrlMatch = first ? firstPresent(first, candidates.url) : { field: null, value: undefined };
  const urlFinding =
    firstUrlMatch.field && typeof firstUrlMatch.value === "string"
      ? (() => {
          const { looksCanonical, host } = classifyUrl(firstUrlMatch.value as string);
          return {
            sampleField: firstUrlMatch.field,
            looksCanonical,
            hostSeen: host,
            example: firstUrlMatch.value as string,
            note: looksCanonical ? "resolves to tiktok.com" : "does NOT resolve to tiktok.com",
          };
        })()
      : { sampleField: null, looksCanonical: false, hostSeen: null, example: null, note: "no URL field present" };

  const idMatch = first ? firstPresent(first, candidates.id) : { field: null, value: undefined };
  const idFinding = {
    candidateField: idMatch.field,
    stable: "UNKNOWN" as const,
    note: idMatch.field ? `present as \`${idMatch.field}\`` : "no ID field present",
  };

  const attribution = assessAttribution(records, attributionCandidates);

  const edgeCaseNotes: string[] = [];
  const noHashtags = records.filter((r) => {
    const v = getPath(r, "hashtags");
    return !Array.isArray(v) || v.length === 0;
  }).length;
  if (noHashtags > 0) edgeCaseNotes.push(`${noHashtags}/${records.length} records had no/empty hashtags array`);
  if (duplicateIdCount > 0) edgeCaseNotes.push(`${duplicateIdCount} duplicate id(s) in the combined result set`);
  if (relevance.pct < 100 && relevance.total > 0) {
    edgeCaseNotes.push(`${relevance.total - relevance.matched}/${relevance.total} records did not match any query term in caption/hashtags`);
  }

  return {
    freshness,
    fieldCoverage,
    viewsMetricNote,
    relevance,
    duplicateIdCount,
    urlFinding,
    idFinding,
    multiQueryAttribution: attribution.verdict,
    multiQueryNote: attribution.note,
    edgeCaseNotes,
  };
}

// ---------------------------------------------------------------------------
// Candidate A — Bright Data discover_by=keyword
// ---------------------------------------------------------------------------

export async function testBrightData(datasetId: string, apiToken: string): Promise<Phase1BCandidateResult> {
  const label = "Bright Data — discover_by=keyword";

  // Smallest possible smoke test first: 1 keyword, tiny limit.
  log(`${label}: smoke test (1 keyword, limit 5)`);
  try {
    const smoke = await brightdata.submitAndCollect(
      {
        datasetId,
        apiToken,
        body: brightdata.buildTikTokKeywordDiscoveryBody([QUERY_TERMS[0]!], 5),
        extraQuery: { notify: "false", type: "discover_new", discover_by: "keyword" },
      },
      `${label} (smoke)`,
      { pollIntervalMs: POLL_INTERVAL_MS, pollTimeoutMs: POLL_TIMEOUT_MS, onLog: log },
    );
    log(`${label}: smoke test OK, ${smoke.rawRecords.length} record(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label}: smoke test FAILED: ${message}`);
    const isAccountInactive = /customer is not active/i.test(message);
    return {
      label,
      provider: "brightdata",
      outcome: "BLOCKED",
      blockedReason: isAccountInactive
        ? "Bright Data account inactive (\"Customer is not active\") — not retried, per Phase 1B stop condition"
        : `smoke test failed: ${message}`,
      errorMessage: null,
      smokeTest: { attempted: true, ok: false, note: message },
      queryTermsUsed: [],
      recordsDelivered: 0,
      freshness: null,
      fieldCoverage: [],
      viewsMetricNote: null,
      relevance: null,
      duplicateIdCount: 0,
      urlFinding: null,
      idFinding: null,
      multiQueryAttribution: "NOT_TESTED",
      multiQueryNote: "not run — smoke test failed",
      asyncLatency: null,
      cost: null,
      fixturesSaved: 0,
      edgeCaseNotes: [],
    };
  }

  // Smoke test passed — run the full 3-keyword x 20 discovery job.
  log(`${label}: full discovery for ${QUERY_TERMS.map((h) => "#" + h).join(", ")}`);
  try {
    const { rawRecords, asyncLatency } = await brightdata.submitAndCollect(
      {
        datasetId,
        apiToken,
        body: brightdata.buildTikTokKeywordDiscoveryBody(QUERY_TERMS, RESULTS_PER_QUERY),
        extraQuery: { notify: "false", type: "discover_new", discover_by: "keyword" },
      },
      label,
      { pollIntervalMs: POLL_INTERVAL_MS, pollTimeoutMs: POLL_TIMEOUT_MS, onLog: log },
    );

    const fixturesSaved = await saveFixtures(
      REPO_ROOT,
      "brightdata",
      "tiktok",
      rawRecords.map((r) => sanitize(r, [apiToken])),
      5,
      "sample-1b",
    );

    const analysis = analyzeRecords({
      provider: "brightdata",
      records: rawRecords,
      attributionCandidates: [
        "input.discovery_input.search_keyword",
        "discovery_input.search_keyword",
        "input",
      ],
    });

    return {
      label,
      provider: "brightdata",
      outcome: "TESTED",
      blockedReason: null,
      errorMessage: null,
      smokeTest: { attempted: true, ok: true, note: "account active, discover_by=keyword accepted the request" },
      queryTermsUsed: QUERY_TERMS,
      recordsDelivered: rawRecords.length,
      cost: {
        recordsRequested: QUERY_TERMS.length * RESULTS_PER_QUERY,
        recordsDelivered: rawRecords.length,
        providerReportedUsage: null,
        estimatedUsd: (rawRecords.length / 1000) * 1.5,
        estimateBasis: "Bright Data documented PAYG rate $1.50/1K records",
      },
      fixturesSaved,
      asyncLatency,
      ...analysis,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label}: full run ERROR: ${message}`);
    return {
      label,
      provider: "brightdata",
      outcome: "ERROR",
      blockedReason: null,
      errorMessage: message,
      smokeTest: { attempted: true, ok: true, note: "smoke test passed; full run then failed" },
      queryTermsUsed: QUERY_TERMS,
      recordsDelivered: 0,
      freshness: null,
      fieldCoverage: [],
      viewsMetricNote: null,
      relevance: null,
      duplicateIdCount: 0,
      urlFinding: null,
      idFinding: null,
      multiQueryAttribution: "NOT_TESTED",
      multiQueryNote: "not evaluated — job errored",
      asyncLatency: null,
      cost: null,
      fixturesSaved: 0,
      edgeCaseNotes: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Candidate B — Apify TikTok SEARCH mode
// ---------------------------------------------------------------------------

export async function testApifySearch(actorId: string, apiToken: string): Promise<Phase1BCandidateResult> {
  const label = "Apify — searchQueries + /video + LATEST + PAST_24_HOURS";
  const input = apify.buildTikTokSearchInput(QUERY_TERMS, RESULTS_PER_QUERY);
  log(`${label}: running actor ${actorId}`);

  try {
    const run = await apify.runActor(actorId, apiToken, input);
    log(`${label}: run ${run.runId} submitted, polling...`);
    const poll = await apify.pollUntilTerminal(run.runId, apiToken, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (poll.finalStatus !== "SUCCEEDED") {
      throw new Error(`run did not succeed (status=${poll.finalStatus}, polls=${poll.pollCount})`);
    }
    const rawRecords = (await apify.getDatasetItems(run.defaultDatasetId, apiToken)) as Record<string, unknown>[];
    log(`${label}: ${rawRecords.length} record(s) delivered in ${poll.totalLatencyMs}ms`);

    const fixturesSaved = await saveFixtures(
      REPO_ROOT,
      "apify",
      "tiktok",
      rawRecords.map((r) => sanitize(r, [apiToken])),
      5,
      "search",
    );

    const analysis = analyzeRecords({
      provider: "apify",
      records: rawRecords,
      attributionCandidates: ["searchQuery", "input.searchQueries", "submittedVideoUrl"],
    });

    return {
      label,
      provider: "apify",
      outcome: "TESTED",
      blockedReason: null,
      errorMessage: null,
      smokeTest: null,
      queryTermsUsed: QUERY_TERMS,
      recordsDelivered: rawRecords.length,
      cost: {
        recordsRequested: QUERY_TERMS.length * RESULTS_PER_QUERY,
        recordsDelivered: rawRecords.length,
        providerReportedUsage: null,
        estimatedUsd: (rawRecords.length / 1000) * 5.0,
        estimateBasis:
          "list price of clockworks/tiktok-scraper ($5/1K); videoSearchSorting/videoSearchDateFilter are " +
          "documented as additional charged filters, so actual cost may be higher — not account-confirmed",
      },
      fixturesSaved,
      asyncLatency: {
        submittedAt: poll.submittedAt,
        readyAt: poll.readyAt,
        totalLatencyMs: poll.totalLatencyMs,
        pollCount: poll.pollCount,
        finalStatus: poll.finalStatus,
      },
      ...analysis,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label}: ERROR: ${message}`);
    return {
      label,
      provider: "apify",
      outcome: "ERROR",
      blockedReason: null,
      errorMessage: message,
      smokeTest: null,
      queryTermsUsed: QUERY_TERMS,
      recordsDelivered: 0,
      freshness: null,
      fieldCoverage: [],
      viewsMetricNote: null,
      relevance: null,
      duplicateIdCount: 0,
      urlFinding: null,
      idFinding: null,
      multiQueryAttribution: "NOT_TESTED",
      multiQueryNote: "not evaluated — job errored",
      asyncLatency: null,
      cost: null,
      fixturesSaved: 0,
      edgeCaseNotes: [],
    };
  }
}

function blockedNoCredentials(label: string, provider: "brightdata" | "apify", reason: string): Phase1BCandidateResult {
  return {
    label,
    provider,
    outcome: "BLOCKED",
    blockedReason: reason,
    errorMessage: null,
    smokeTest: null,
    queryTermsUsed: [],
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    relevance: null,
    duplicateIdCount: 0,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "not run — credentials unavailable",
    asyncLatency: null,
    cost: null,
    fixturesSaved: 0,
    edgeCaseNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const creds = loadSpikeCredentials(REPO_ROOT);
  const availability = checkAvailability(creds);
  const secrets = collectSecretValues(creds);

  log(`Bright Data credentials: ${creds.brightData ? "present" : "NOT SET"}`);
  log(`Apify credentials: ${creds.apify ? "present" : "NOT SET"}`);

  const candidates: Phase1BCandidateResult[] = [];

  if (availability.brightdataTiktok.available) {
    candidates.push(await testBrightData(creds.brightData!.datasetTikTokPosts!, creds.brightData!.apiToken));
  } else {
    candidates.push(
      blockedNoCredentials("Bright Data — discover_by=keyword", "brightdata", availability.brightdataTiktok.detail),
    );
  }

  if (availability.apifyTiktok.available) {
    candidates.push(await testApifySearch(creds.apify!.actorTikTok!, creds.apify!.apiToken));
  } else {
    candidates.push(
      blockedNoCredentials(
        "Apify — searchQueries + /video + LATEST + PAST_24_HOURS",
        "apify",
        availability.apifyTiktok.detail,
      ),
    );
  }

  const results: Phase1BResults = {
    executedAt: new Date().toISOString(),
    queryTerms: QUERY_TERMS,
    resultsPerQuery: RESULTS_PER_QUERY,
    candidates,
  };

  const spikeDir = resolve(REPO_ROOT, ".spike");
  await mkdir(spikeDir, { recursive: true });
  await writeFile(
    resolve(spikeDir, "results-1b.json"),
    JSON.stringify(sanitize(results, secrets), null, 2) + "\n",
    "utf8",
  );

  const reportPath = resolve(REPO_ROOT, "docs", "PROVIDER_SPIKE.md");
  const existing = await readFile(reportPath, "utf8").catch(() => "# Provider Spike\n");
  const section = buildPhase1BSection(results);
  await writeFile(reportPath, upsertPhase1BSection(existing, section), "utf8");

  log(`Wrote .spike/results-1b.json and updated docs/PROVIDER_SPIKE.md (Phase 1B section)`);

  const totalDelivered = candidates.reduce((sum, c) => sum + c.recordsDelivered, 0);
  log(`Total records delivered this run: ${totalDelivered}`);
}

// Only auto-run when this file is executed directly (`node
// scripts/provider-spike-1b.ts`), not when imported by another script
// (e.g. a targeted single-candidate retry) — otherwise importing any
// exported function here would silently re-run the entire spike.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[spike-1b] FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
