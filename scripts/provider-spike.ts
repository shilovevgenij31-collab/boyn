/**
 * Phase 1 — Provider spike orchestrator.
 *
 * Standalone experiment: makes a small number of REAL calls to Bright Data
 * and/or Apify (whichever have credentials configured), measures freshness/
 * field coverage/URL & ID stability/multi-query attribution/refresh-by-URL
 * support/cost, saves sanitized fixtures, and writes:
 *   - .spike/results.json   (gitignored, full machine-readable output)
 *   - docs/PROVIDER_SPIKE.md (committed, human-readable report)
 *
 * Run: `node scripts/provider-spike.ts`
 *
 * This does NOT build the production SocialDataProvider (Phase 4), a
 * database, Telegram, or orchestration — see
 * docs/IMPLEMENTATION_PLAN.md §28 Phase 1 for exact scope.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { checkAvailability, collectSecretValues, loadSpikeCredentials } from "./provider-spike/env.ts";
import { sanitize } from "./provider-spike/sanitize.ts";
import { computeFreshnessStats } from "./provider-spike/freshness.ts";
import { computeFieldCoverage } from "./provider-spike/coverage.ts";
import { allCandidateFieldPaths, FIELD_CANDIDATES, firstPresent, getPath, parseTimestamp } from "./provider-spike/extract.ts";
import { buildReportMarkdown } from "./provider-spike/report.ts";
import { saveFixtures as sharedSaveFixtures } from "./provider-spike/fixtures.ts";
import * as brightdata from "./provider-spike/brightdata.ts";
import * as apify from "./provider-spike/apify.ts";
import type {
  CombinationKey,
  CombinationResult,
  PlatformName,
  ProviderName,
  RefreshByUrlFinding,
  SpikeResults,
  SupportVerdict,
} from "./provider-spike/types.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HASHTAGS = ["cosplay", "gaming", "ps5"];
const RESULTS_PER_HASHTAG = 20;
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 4 * 60_000; // keep the spike bounded

function log(msg: string): void {
  console.log(`[spike] ${msg}`);
}

function blockedResult(provider: ProviderName, platform: PlatformName, reason: string): CombinationResult {
  return {
    provider,
    platform,
    outcome: "BLOCKED",
    blockedReason: reason,
    errorMessage: null,
    hashtagsQueried: [],
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "not run — credentials unavailable",
    asyncLatency: null,
    refreshByUrl: null,
    edgeCaseNotes: [],
    cost: null,
    fixturesSaved: 0,
  };
}

function errorResult(
  provider: ProviderName,
  platform: PlatformName,
  hashtagsQueried: string[],
  error: unknown,
): CombinationResult {
  return {
    provider,
    platform,
    outcome: "ERROR",
    blockedReason: null,
    errorMessage: error instanceof Error ? error.message : String(error),
    hashtagsQueried,
    recordsDelivered: 0,
    freshness: null,
    fieldCoverage: [],
    viewsMetricNote: null,
    urlFinding: null,
    idFinding: null,
    multiQueryAttribution: "NOT_TESTED",
    multiQueryNote: "not evaluated — job errored",
    asyncLatency: null,
    refreshByUrl: null,
    edgeCaseNotes: [],
    cost: null,
    fixturesSaved: 0,
  };
}

/** Canonical-host check: is this a real tiktok.com/instagram.com permalink,
 * or a provider/CDN URL that must never reach an end user? */
function classifyUrl(platform: PlatformName, url: string): { looksCanonical: boolean; host: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const expected = platform === "tiktok" ? "tiktok.com" : "instagram.com";
    return { looksCanonical: host === expected, host };
  } catch {
    return { looksCanonical: false, host: null };
  }
}

/** Heuristic multi-query attribution check: does the record carry an
 * explicit reference to the input hashtag that found it, or do we have to
 * infer it (ambiguously) from the record's own hashtag list? */
function assessMultiQueryAttribution(
  records: Record<string, unknown>[],
  queriedHashtags: string[],
): { verdict: SupportVerdict; note: string } {
  if (records.length === 0) return { verdict: "NOT_TESTED", note: "no records returned" };

  const explicitFieldCandidates = [
    // "input.discovery_input.search_keyword" verified 2026-09-12 against a
    // real Bright Data record (Phase 1B smoke test).
    "input.discovery_input.search_keyword",
    "discovery_input.search_keyword",
    "input.hashtag",
    "input.search_keyword",
    "search_keyword",
    "searchHashtag",
    "input",
  ];
  const withExplicit = records.filter(
    (r) => firstPresent(r, explicitFieldCandidates).field !== null,
  ).length;
  if (withExplicit === records.length) {
    return {
      verdict: "SUPPORTED",
      note: `every record carries an explicit input-attribution field (checked: ${explicitFieldCandidates.join(", ")})`,
    };
  }
  if (withExplicit > 0) {
    return {
      verdict: "AMBIGUOUS",
      note: `${withExplicit}/${records.length} records carry an explicit attribution field; rest do not`,
    };
  }

  // No explicit field: see whether the record's own hashtags at least let us
  // infer a plausible (but not certain) source query.
  const lowerQueried = new Set(queriedHashtags.map((h) => h.toLowerCase().replace(/^#/, "")));
  const inferable = records.filter((r) => {
    const tags = getPath(r, "hashtags");
    if (!Array.isArray(tags)) return false;
    return tags.some((t) => typeof t === "string" && lowerQueried.has(t.toLowerCase().replace(/^#/, "")));
  }).length;

  if (inferable === 0) {
    return {
      verdict: "NOT_SUPPORTED",
      note: "no explicit attribution field, and record hashtags don't reliably indicate the querying tag",
    };
  }
  return {
    verdict: "AMBIGUOUS",
    note:
      `no explicit attribution field; ${inferable}/${records.length} records CONTAIN one of the queried ` +
      "hashtags in their own tag list, but a post can rank for multiple queried tags at once, so this is " +
      "an inference, not a guarantee — treat as one job per (platform, tag) for Phase 4 unless a real " +
      "attribution field is confirmed against the live API response.",
  };
}

function saveFixtures(
  provider: ProviderName,
  platform: PlatformName,
  sanitizedRecords: unknown[],
  max = 5,
  prefix: "sample" | "refresh" = "sample",
): Promise<number> {
  return sharedSaveFixtures(REPO_ROOT, provider, platform, sanitizedRecords, max, prefix);
}

function buildCombinationResult(params: {
  provider: ProviderName;
  platform: PlatformName;
  hashtagsQueried: string[];
  rawRecords: Record<string, unknown>[];
  asyncLatency: CombinationResult["asyncLatency"];
  cost: CombinationResult["cost"];
  fixturesSaved: number;
}): CombinationResult {
  const { provider, platform, hashtagsQueried, rawRecords, asyncLatency, cost, fixturesSaved } = params;
  const key = `${provider}_${platform}` as CombinationKey;
  const candidates = FIELD_CANDIDATES[key];

  const publishedDates = rawRecords.map((r) => parseTimestamp(firstPresent(r, candidates.publishedAt).value));
  const freshness = computeFreshnessStats(publishedDates, new Date());

  const coverageFields = allCandidateFieldPaths(candidates);
  const fieldCoverage = computeFieldCoverage(rawRecords, coverageFields);

  const viewMatches = rawRecords.map((r) => firstPresent(r, candidates.views));
  const viewFieldsSeen = [...new Set(viewMatches.map((m) => m.field).filter((f): f is string => f !== null))];
  const viewsMetricNote =
    viewFieldsSeen.length === 0
      ? "no configured view-count candidate field was present on any record — check raw fixtures for the real field name"
      : viewFieldsSeen.length === 1
        ? `consistently \`${viewFieldsSeen[0]}\` (checked candidates: ${candidates.views.join(", ")})`
        : `INCONSISTENT across records: saw ${viewFieldsSeen.map((f) => `\`${f}\``).join(", ")} — do not assume a single field`;

  const firstUrlMatch = rawRecords.length > 0 ? firstPresent(rawRecords[0]!, candidates.url) : { field: null, value: undefined };
  const urlFinding =
    firstUrlMatch.field && typeof firstUrlMatch.value === "string"
      ? (() => {
          const { looksCanonical, host } = classifyUrl(platform, firstUrlMatch.value as string);
          return {
            sampleField: firstUrlMatch.field,
            looksCanonical,
            hostSeen: host,
            example: firstUrlMatch.value as string,
            note: looksCanonical
              ? "resolves to the platform's own domain — usable directly as canonical_url, but still re-validate host allowlist in Phase 2, don't trust blindly"
              : "does NOT resolve to the platform's own domain — Phase 2 must construct the canonical URL from (username, external_id) instead of trusting this field",
          };
        })()
      : { sampleField: null, looksCanonical: false, hostSeen: null, example: null, note: "no URL candidate field present on the first record" };

  const idMatch = rawRecords.length > 0 ? firstPresent(rawRecords[0]!, candidates.id) : { field: null, value: undefined };
  const idFinding = {
    candidateField: idMatch.field,
    stable: "UNKNOWN" as const,
    note: idMatch.field
      ? `present as \`${idMatch.field}\`; stability is only strongly confirmed by the refresh-by-URL check below returning the same value`
      : "no ID candidate field present on the first record",
  };

  const multiQuery = assessMultiQueryAttribution(rawRecords, hashtagsQueried);

  const edgeCaseNotes: string[] = [];
  const nullViewCount = rawRecords.filter((r) => firstPresent(r, candidates.views).field === null).length;
  if (nullViewCount > 0) edgeCaseNotes.push(`${nullViewCount}/${rawRecords.length} records had no view-count field present at all`);
  const negativeLikeCount = rawRecords.filter((r) => {
    const v = firstPresent(r, candidates.likes).value;
    return typeof v === "number" && v < 0;
  }).length;
  if (negativeLikeCount > 0) edgeCaseNotes.push(`${negativeLikeCount} record(s) had a negative likes value (e.g. -1 for hidden counts)`);
  const stringNumericCount = rawRecords.filter((r) => {
    const v = firstPresent(r, candidates.views).value;
    return typeof v === "string" && /^\d+$/.test(v);
  }).length;
  if (stringNumericCount > 0) edgeCaseNotes.push(`${stringNumericCount} record(s) returned a numeric metric as a string`);
  const noHashtagsCount = rawRecords.filter((r) => {
    const v = getPath(r, "hashtags");
    return !Array.isArray(v) || v.length === 0;
  }).length;
  if (noHashtagsCount > 0) edgeCaseNotes.push(`${noHashtagsCount}/${rawRecords.length} records had no/empty hashtags array`);
  const seenIds = new Set<unknown>();
  let duplicateIdCount = 0;
  for (const r of rawRecords) {
    const idValue = firstPresent(r, candidates.id).value;
    if (idValue !== undefined) {
      if (seenIds.has(idValue)) duplicateIdCount += 1;
      seenIds.add(idValue);
    }
  }
  if (duplicateIdCount > 0) edgeCaseNotes.push(`${duplicateIdCount} duplicate id(s) across the combined multi-hashtag result set (expected when the same post matches >1 queried tag)`);

  return {
    provider,
    platform,
    outcome: "TESTED",
    blockedReason: null,
    errorMessage: null,
    hashtagsQueried,
    recordsDelivered: rawRecords.length,
    freshness,
    fieldCoverage,
    viewsMetricNote,
    urlFinding,
    idFinding,
    multiQueryAttribution: multiQuery.verdict,
    multiQueryNote: multiQuery.note,
    asyncLatency,
    refreshByUrl: null, // filled in by caller after the refresh experiment
    edgeCaseNotes,
    cost,
    fixturesSaved,
  };
}

// ---------------------------------------------------------------------------
// Bright Data — TikTok only. Instagram has no verified hashtag-discovery
// endpoint on this account (see module doc comment in provider-spike/brightdata.ts);
// it is intentionally not attempted here, not just blocked on a missing env var.
// ---------------------------------------------------------------------------

async function testBrightDataTikTok(datasetId: string, apiToken: string): Promise<CombinationResult> {
  const body = brightdata.buildTikTokKeywordDiscoveryBody(HASHTAGS, RESULTS_PER_HASHTAG);
  log(`Bright Data / tiktok: discover-by-keyword for ${HASHTAGS.map((h) => "#" + h).join(", ")}`);

  const { rawRecords, asyncLatency } = await brightdata.submitAndCollect(
    {
      datasetId,
      apiToken,
      body,
      extraQuery: { notify: "false", type: "discover_new", discover_by: "keyword" },
    },
    "Bright Data / tiktok discovery",
    { pollIntervalMs: POLL_INTERVAL_MS, pollTimeoutMs: POLL_TIMEOUT_MS, onLog: log },
  );

  const fixturesSaved = await saveFixtures("brightdata", "tiktok", rawRecords.map((r) => sanitize(r, [apiToken])));

  const result = buildCombinationResult({
    provider: "brightdata",
    platform: "tiktok",
    hashtagsQueried: HASHTAGS,
    rawRecords,
    asyncLatency,
    cost: {
      recordsRequested: HASHTAGS.length * RESULTS_PER_HASHTAG,
      recordsDelivered: rawRecords.length,
      providerReportedUsage: null, // not exposed by this endpoint; see report note
      estimatedUsd: (rawRecords.length / 1000) * 1.5,
      estimateBasis: "Bright Data documented PAYG rate $1.50/1K records (§3.1), not an account-reported charge",
    },
    fixturesSaved,
  });

  result.refreshByUrl = await tryBrightDataTikTokRefresh(datasetId, apiToken, rawRecords, result);
  return result;
}

async function tryBrightDataTikTokRefresh(
  datasetId: string,
  apiToken: string,
  rawRecords: Record<string, unknown>[],
  discoveryResult: CombinationResult,
): Promise<RefreshByUrlFinding> {
  const candidates = FIELD_CANDIDATES.brightdata_tiktok;
  const first = rawRecords[0];
  const url = first ? firstPresent(first, candidates.url).value : undefined;
  const originalId = first ? firstPresent(first, candidates.id).value : undefined;
  const originalViewsRaw = first ? firstPresent(first, candidates.views).value : undefined;
  const originalViews = typeof originalViewsRaw === "number" ? originalViewsRaw : null;

  if (typeof url !== "string") {
    return {
      verdict: "NOT_TESTED",
      originalExternalId: null,
      refreshedExternalId: null,
      sameExternalId: null,
      originalViews: null,
      refreshedViews: null,
      latencyMs: null,
      note: "no discovered post had a usable URL to refresh",
    };
  }

  try {
    log(`Bright Data / tiktok: attempting collect-by-URL refresh for one discovered post`);
    const startedAt = Date.now();
    const { rawRecords: refreshedRecords } = await brightdata.submitAndCollect(
      { datasetId, apiToken, body: brightdata.buildCollectByUrlBody([url]) },
      "Bright Data / tiktok refresh",
      { pollIntervalMs: POLL_INTERVAL_MS, pollTimeoutMs: POLL_TIMEOUT_MS, onLog: log },
    );
    const refreshed = refreshedRecords[0];
    const refreshedId = refreshed ? firstPresent(refreshed, candidates.id).value : undefined;
    const refreshedViewsRaw = refreshed ? firstPresent(refreshed, candidates.views).value : undefined;
    const refreshedViews = typeof refreshedViewsRaw === "number" ? refreshedViewsRaw : null;

    await saveFixtures("brightdata", "tiktok", refreshedRecords.map((r) => sanitize(r, [apiToken])), 1, "refresh");
    discoveryResult.fixturesSaved += refreshedRecords.length > 0 ? 1 : 0;

    return {
      verdict: refreshedRecords.length === 1 ? "SUPPORTED" : refreshedRecords.length > 1 ? "PARTIAL" : "NOT_SUPPORTED",
      originalExternalId: originalId !== undefined ? String(originalId) : null,
      refreshedExternalId: refreshedId !== undefined ? String(refreshedId) : null,
      sameExternalId: originalId !== undefined && refreshedId !== undefined ? String(originalId) === String(refreshedId) : null,
      originalViews,
      refreshedViews,
      latencyMs: Date.now() - startedAt,
      note:
        refreshedRecords.length === 1
          ? "collect-by-URL returned exactly one record for the given URL"
          : `collect-by-URL returned ${refreshedRecords.length} record(s) for one URL (expected 1)`,
    };
  } catch (error) {
    return {
      verdict: "NOT_SUPPORTED",
      originalExternalId: originalId !== undefined ? String(originalId) : null,
      refreshedExternalId: null,
      sameExternalId: null,
      originalViews,
      refreshedViews: null,
      latencyMs: null,
      note: `collect-by-URL attempt errored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Apify
// ---------------------------------------------------------------------------

async function testApifyPlatform(
  platform: PlatformName,
  actorId: string,
  apiToken: string,
): Promise<CombinationResult> {
  const input =
    platform === "tiktok"
      ? apify.buildTikTokHashtagInput(HASHTAGS, RESULTS_PER_HASHTAG)
      : apify.buildInstagramHashtagInput(HASHTAGS, RESULTS_PER_HASHTAG);
  // Verified 2026-09-12 (see apify.ts module doc comment): clockworks/tiktok-scraper
  // documents `postURLs`; apify/instagram-hashtag-scraper documents NO url-input
  // field at all. TikTok refresh is attempted for real below; Instagram refresh
  // is reported NOT_SUPPORTED from the confirmed schema without spending a run.

  log(`Apify / ${platform}: running actor ${actorId} for ${HASHTAGS.map((h) => "#" + h).join(", ")}`);
  const run = await apify.runActor(actorId, apiToken, input);
  log(`Apify / ${platform}: run ${run.runId} submitted, polling...`);

  const poll = await apify.pollUntilTerminal(run.runId, apiToken, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  if (poll.finalStatus !== "SUCCEEDED") {
    throw new Error(`Apify ${platform} run did not succeed (status=${poll.finalStatus}, polls=${poll.pollCount})`);
  }

  const rawRecords = (await apify.getDatasetItems(run.defaultDatasetId, apiToken)) as Record<string, unknown>[];
  log(`Apify / ${platform}: ${rawRecords.length} record(s) delivered in ${poll.totalLatencyMs}ms`);

  const fixturesSaved = await saveFixtures("apify", platform, rawRecords.map((r) => sanitize(r, [apiToken])));

  const estimatePerK = platform === "tiktok" ? 5.0 : 2.3;
  const result = buildCombinationResult({
    provider: "apify",
    platform,
    hashtagsQueried: HASHTAGS,
    rawRecords,
    asyncLatency: {
      submittedAt: poll.submittedAt,
      readyAt: poll.readyAt,
      totalLatencyMs: poll.totalLatencyMs,
      pollCount: poll.pollCount,
      finalStatus: poll.finalStatus,
    },
    cost: {
      recordsRequested: HASHTAGS.length * RESULTS_PER_HASHTAG,
      recordsDelivered: rawRecords.length,
      providerReportedUsage: null, // Apify exposes this via account usage API, not the run response; not queried in this spike
      estimatedUsd: (rawRecords.length / 1000) * estimatePerK,
      estimateBasis: `list price of the DEFAULT actor researched in §3.1 ($${estimatePerK}/1K) — re-check if actor "${actorId}" differs`,
    },
    fixturesSaved,
  });

  result.refreshByUrl =
    platform === "tiktok"
      ? await tryApifyTikTokRefresh(actorId, apiToken, rawRecords, result)
      : apifyInstagramRefreshNotSupported(rawRecords);
  return result;
}

/** Real attempt: clockworks/tiktok-scraper documents `postURLs` as a direct-
 * video-URL input field (verified 2026-09-12). */
async function tryApifyTikTokRefresh(
  actorId: string,
  apiToken: string,
  rawRecords: Record<string, unknown>[],
  discoveryResult: CombinationResult,
): Promise<RefreshByUrlFinding> {
  const candidates = FIELD_CANDIDATES.apify_tiktok;
  const first = rawRecords[0];
  const url = first ? firstPresent(first, candidates.url).value : undefined;
  const originalId = first ? firstPresent(first, candidates.id).value : undefined;
  const originalViewsRaw = first ? firstPresent(first, candidates.views).value : undefined;
  const originalViews = typeof originalViewsRaw === "number" ? originalViewsRaw : null;

  if (typeof url !== "string") {
    return {
      verdict: "NOT_TESTED",
      originalExternalId: null,
      refreshedExternalId: null,
      sameExternalId: null,
      originalViews: null,
      refreshedViews: null,
      latencyMs: null,
      note: "no discovered post had a usable URL to refresh",
    };
  }

  try {
    log(`Apify / tiktok: attempting postURLs refresh for one discovered post`);
    const startedAt = Date.now();
    const run = await apify.runActor(actorId, apiToken, apify.buildTikTokPostUrlInput([url]));
    const poll = await apify.pollUntilTerminal(run.runId, apiToken, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (poll.finalStatus !== "SUCCEEDED") {
      return {
        verdict: "NOT_SUPPORTED",
        originalExternalId: originalId !== undefined ? String(originalId) : null,
        refreshedExternalId: null,
        sameExternalId: null,
        originalViews,
        refreshedViews: null,
        latencyMs: Date.now() - startedAt,
        note: `postURLs run did not succeed (status=${poll.finalStatus})`,
      };
    }
    const refreshedRecords = (await apify.getDatasetItems(run.defaultDatasetId, apiToken)) as Record<string, unknown>[];
    const refreshed = refreshedRecords[0];
    const refreshedId = refreshed ? firstPresent(refreshed, candidates.id).value : undefined;
    const refreshedViewsRaw = refreshed ? firstPresent(refreshed, candidates.views).value : undefined;
    const refreshedViews = typeof refreshedViewsRaw === "number" ? refreshedViewsRaw : null;

    await saveFixtures("apify", "tiktok", refreshedRecords.map((r) => sanitize(r, [apiToken])), 1, "refresh");
    discoveryResult.fixturesSaved += refreshedRecords.length > 0 ? 1 : 0;

    return {
      verdict: refreshedRecords.length === 1 ? "SUPPORTED" : refreshedRecords.length > 1 ? "PARTIAL" : "NOT_SUPPORTED",
      originalExternalId: originalId !== undefined ? String(originalId) : null,
      refreshedExternalId: refreshedId !== undefined ? String(refreshedId) : null,
      sameExternalId: originalId !== undefined && refreshedId !== undefined ? String(originalId) === String(refreshedId) : null,
      originalViews,
      refreshedViews,
      latencyMs: Date.now() - startedAt,
      note:
        refreshedRecords.length === 1
          ? "postURLs returned exactly one record for the given URL"
          : `postURLs returned ${refreshedRecords.length} record(s) for one URL (expected 1)`,
    };
  } catch (error) {
    return {
      verdict: "NOT_SUPPORTED",
      originalExternalId: originalId !== undefined ? String(originalId) : null,
      refreshedExternalId: null,
      sameExternalId: null,
      originalViews,
      refreshedViews: null,
      latencyMs: null,
      note: `postURLs attempt errored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** No network call: apify/instagram-hashtag-scraper's current input schema
 * (verified 2026-09-12 against apify.com/apify/instagram-hashtag-scraper/api/param)
 * has no URL-input field at all — spending a paid run to confirm the
 * already-documented absence would be wasteful, per Phase 1 cost discipline. */
function apifyInstagramRefreshNotSupported(rawRecords: Record<string, unknown>[]): RefreshByUrlFinding {
  const candidates = FIELD_CANDIDATES.apify_instagram;
  const first = rawRecords[0];
  const originalId = first ? firstPresent(first, candidates.id).value : undefined;
  const originalViewsRaw = first ? firstPresent(first, candidates.views).value : undefined;
  return {
    verdict: "NOT_SUPPORTED",
    originalExternalId: originalId !== undefined ? String(originalId) : null,
    refreshedExternalId: null,
    sameExternalId: null,
    originalViews: typeof originalViewsRaw === "number" ? originalViewsRaw : null,
    refreshedViews: null,
    latencyMs: null,
    note:
      "not attempted (no paid call made): the actor's current published input schema has no " +
      "URL-input field, so a direct-URL refresh isn't supported by this actor — a different " +
      "Instagram actor would be needed for refresh-by-URL.",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const creds = loadSpikeCredentials(REPO_ROOT);
  const availability = checkAvailability(creds);
  const secrets = collectSecretValues(creds);

  const anyAvailable = Object.values(availability).some((a) => a.available);

  log(`Bright Data credentials: ${creds.brightData ? "present" : "NOT SET (BRIGHTDATA_API_TOKEN)"}`);
  log(`Apify credentials: ${creds.apify ? "present" : "NOT SET (APIFY_API_TOKEN)"}`);
  log(
    `Availability: brightdata/tiktok=${availability.brightdataTiktok.available} ` +
      `brightdata/instagram=${availability.brightdataInstagram.available} ` +
      `apify/tiktok=${availability.apifyTiktok.available} ` +
      `apify/instagram=${availability.apifyInstagram.available}`,
  );

  const combinations: CombinationResult[] = [];

  // Bright Data / TikTok
  if (availability.brightdataTiktok.available) {
    try {
      combinations.push(
        await testBrightDataTikTok(creds.brightData!.datasetTikTokPosts!, creds.brightData!.apiToken),
      );
    } catch (error) {
      log(`Bright Data / tiktok ERROR: ${error instanceof Error ? error.message : String(error)}`);
      combinations.push(errorResult("brightdata", "tiktok", HASHTAGS, error));
    }
  } else {
    combinations.push(blockedResult("brightdata", "tiktok", availability.brightdataTiktok.detail));
  }

  // Bright Data / Instagram — intentionally never attempted in Phase 1: no
  // verified hashtag-discovery endpoint exists on this account (manually
  // inspected; see docs/PROVIDER_SPIKE.md and BRIGHTDATA_DATASET_INSTAGRAM_POSTS
  // is deliberately left unset). Always BLOCKED, by design, not by omission.
  combinations.push(
    blockedResult(
      "brightdata",
      "instagram",
      availability.brightdataInstagram.available
        ? "deliberately not attempted — no verified Instagram hashtag-discovery endpoint on this account"
        : availability.brightdataInstagram.detail,
    ),
  );

  // Apify / TikTok
  if (availability.apifyTiktok.available) {
    try {
      combinations.push(await testApifyPlatform("tiktok", creds.apify!.actorTikTok!, creds.apify!.apiToken));
    } catch (error) {
      log(`Apify / tiktok ERROR: ${error instanceof Error ? error.message : String(error)}`);
      combinations.push(errorResult("apify", "tiktok", HASHTAGS, error));
    }
  } else {
    combinations.push(blockedResult("apify", "tiktok", availability.apifyTiktok.detail));
  }

  // Apify / Instagram
  if (availability.apifyInstagram.available) {
    try {
      combinations.push(await testApifyPlatform("instagram", creds.apify!.actorInstagram!, creds.apify!.apiToken));
    } catch (error) {
      log(`Apify / instagram ERROR: ${error instanceof Error ? error.message : String(error)}`);
      combinations.push(errorResult("apify", "instagram", HASHTAGS, error));
    }
  } else {
    combinations.push(blockedResult("apify", "instagram", availability.apifyInstagram.detail));
  }

  const results: SpikeResults = {
    executedAt: new Date().toISOString(),
    hashtagsUsed: HASHTAGS,
    resultsPerHashtag: RESULTS_PER_HASHTAG,
    combinations,
  };

  const spikeDir = resolve(REPO_ROOT, ".spike");
  await mkdir(spikeDir, { recursive: true });
  await writeFile(
    resolve(spikeDir, "results.json"),
    JSON.stringify(sanitize(results, secrets), null, 2) + "\n",
    "utf8",
  );

  const reportMarkdown = buildReportMarkdown(results);
  await writeFile(resolve(REPO_ROOT, "docs", "PROVIDER_SPIKE.md"), reportMarkdown, "utf8");

  log(`Wrote .spike/results.json and docs/PROVIDER_SPIKE.md`);

  if (!anyAvailable) {
    log("");
    log("=".repeat(72));
    log("ALL provider credentials are missing. No network calls were made.");
    log("To run the spike for real, set in .env.local (repo root):");
    log("  BRIGHTDATA_API_TOKEN, BRIGHTDATA_DATASET_TIKTOK_POSTS (Instagram: no verified endpoint, see report)");
    log("  APIFY_API_TOKEN, APIFY_ACTOR_TIKTOK, APIFY_ACTOR_INSTAGRAM");
    log("Then re-run: node scripts/provider-spike.ts");
    log("=".repeat(72));
  }
}

main().catch((error) => {
  console.error(`[spike] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
