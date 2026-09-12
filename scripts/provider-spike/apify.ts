/**
 * Minimal Apify REST client, just enough for the Phase 1 spike: run an
 * actor, poll the run, fetch the resulting dataset items.
 *
 * Verified from apify docs during planning (see
 * docs/IMPLEMENTATION_PLAN.md §3.1):
 *   POST /v2/acts/{actorId}/runs        -> { data: { id, defaultDatasetId, status } }
 *   GET  /v2/actor-runs/{runId}         -> { data: { status, ... } }
 *   GET  /v2/datasets/{datasetId}/items -> array of items
 *
 * Actor input field names below (hashtags/resultsPerPage/sorting for
 * clockworks/tiktok-scraper; hashtags/resultsLimit/resultsType for
 * apify/instagram-hashtag-scraper) come from each actor's published input
 * schema as researched in planning, not from a live account — if the
 * configured actor (APIFY_ACTOR_TIKTOK / APIFY_ACTOR_INSTAGRAM) differs,
 * check its actual input schema on Apify Console before trusting results.
 */
import { fetchJson } from "./http.ts";

const BASE_URL = "https://api.apify.com/v2";

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

export interface ApifyRunResult {
  runId: string;
  defaultDatasetId: string;
  requestUrl: string;
  requestBody: unknown;
  responseStatus: number;
  latencyMs: number;
}

export async function runActor(
  actorId: string,
  apiToken: string,
  input: Record<string, unknown>,
): Promise<ApifyRunResult> {
  const url = `${BASE_URL}/acts/${encodeURIComponent(actorId)}/runs`;
  const result = await fetchJson<{ data?: { id?: string; defaultDatasetId?: string } }>(url, {
    method: "POST",
    headers: authHeaders(apiToken),
    body: input,
    timeoutMs: 30_000,
  });

  const runId = result.json?.data?.id;
  const defaultDatasetId = result.json?.data?.defaultDatasetId;
  if (!result.ok || !runId || !defaultDatasetId) {
    throw new Error(
      `Apify run actor failed: status=${result.status} body=${JSON.stringify(result.json ?? result.rawText).slice(0, 500)}`,
    );
  }

  return {
    runId,
    defaultDatasetId,
    requestUrl: url,
    requestBody: input,
    responseStatus: result.status,
    latencyMs: result.latencyMs,
  };
}

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED-OUT"
  | "ABORTED"
  | "UNKNOWN";

const TERMINAL_STATUSES: ReadonlySet<ApifyRunStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED-OUT",
  "ABORTED",
]);

export async function getRunStatus(runId: string, apiToken: string): Promise<ApifyRunStatus> {
  const url = `${BASE_URL}/actor-runs/${encodeURIComponent(runId)}`;
  const result = await fetchJson<{ data?: { status?: string } }>(url, {
    method: "GET",
    headers: authHeaders(apiToken),
    timeoutMs: 15_000,
  });
  return (result.json?.data?.status as ApifyRunStatus) ?? "UNKNOWN";
}

export async function getDatasetItems(datasetId: string, apiToken: string): Promise<unknown[]> {
  const url = `${BASE_URL}/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true`;
  const result = await fetchJson<unknown>(url, {
    method: "GET",
    headers: authHeaders(apiToken),
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`Apify dataset items fetch failed: status=${result.status}`);
  }
  return Array.isArray(result.json) ? result.json : [];
}

export interface ApifyPollResult {
  finalStatus: ApifyRunStatus;
  pollCount: number;
  submittedAt: number;
  readyAt: number | null;
  totalLatencyMs: number;
}

export async function pollUntilTerminal(
  runId: string,
  apiToken: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<ApifyPollResult> {
  const { intervalMs = 10_000, timeoutMs = 5 * 60_000 } = options;
  const submittedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - submittedAt < timeoutMs) {
    pollCount += 1;
    const status = await getRunStatus(runId, apiToken);
    if (TERMINAL_STATUSES.has(status)) {
      const readyAt = Date.now();
      return { finalStatus: status, pollCount, submittedAt, readyAt, totalLatencyMs: readyAt - submittedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    finalStatus: "UNKNOWN",
    pollCount,
    submittedAt,
    readyAt: null,
    totalLatencyMs: Date.now() - submittedAt,
  };
}

export function buildTikTokHashtagInput(
  hashtags: string[],
  resultsPerPage: number,
): Record<string, unknown> {
  return {
    hashtags: hashtags.map((h) => h.replace(/^#/, "")),
    resultsPerPage,
    sorting: "latest",
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };
}

export function buildInstagramHashtagInput(
  hashtags: string[],
  resultsLimit: number,
): Record<string, unknown> {
  return {
    hashtags: hashtags.map((h) => h.replace(/^#/, "")),
    resultsLimit,
    resultsType: "reels",
  };
}
