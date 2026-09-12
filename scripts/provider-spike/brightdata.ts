/**
 * Minimal Bright Data "Web Scraper API" (datasets v3) REST client, just
 * enough for the Phase 1 spike: trigger an async collection job, poll it,
 * fetch the snapshot.
 *
 * Verified from docs.brightdata.com during planning (see
 * docs/IMPLEMENTATION_PLAN.md §3.1):
 *   POST /datasets/v3/trigger   -> { snapshot_id }
 *   GET  /datasets/v3/progress/{snapshot_id} -> { status: starting|running|ready|failed, ... }
 *   GET  /datasets/v3/snapshot/{snapshot_id}?format=json -> array of records
 *
 * NOT verified (no account access during planning): the exact per-dataset
 * input row shape for hashtag/keyword discovery (e.g. field names like
 * "hashtag" vs "search_keyword", and whether discovery needs
 * `type=discover_new&discover_by=...` query params or a different
 * mechanism). Bright Data's datasets are configured per marketplace
 * listing; the authoritative source is the account's own "API" tab for
 * that specific dataset_id. `buildHashtagDiscoveryInput` below is a
 * best-effort default that the spike logs in full (sanitized) so a human
 * can correct it against the real dataset docs on first real run.
 */
import { fetchJson } from "./http.ts";

const BASE_URL = "https://api.brightdata.com/datasets/v3";

export interface BrightDataTriggerParams {
  datasetId: string;
  apiToken: string;
  rows: Record<string, unknown>[];
  /** Extra query params, e.g. { type: "discover_new", discover_by: "hashtag" }. */
  extraQuery?: Record<string, string>;
  notifyUrl?: string;
}

export interface BrightDataTriggerResult {
  snapshotId: string;
  requestUrl: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
  latencyMs: number;
}

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

export async function triggerJob(params: BrightDataTriggerParams): Promise<BrightDataTriggerResult> {
  const query = new URLSearchParams({
    dataset_id: params.datasetId,
    include_errors: "true",
    format: "json",
    ...(params.notifyUrl ? { notify: params.notifyUrl } : {}),
    ...params.extraQuery,
  });
  const url = `${BASE_URL}/trigger?${query.toString()}`;

  const result = await fetchJson<{ snapshot_id?: string }>(url, {
    method: "POST",
    headers: authHeaders(params.apiToken),
    body: params.rows,
    timeoutMs: 30_000,
  });

  const snapshotId = result.json?.snapshot_id;
  if (!result.ok || !snapshotId) {
    throw new Error(
      `Bright Data trigger failed: status=${result.status} body=${JSON.stringify(result.json ?? result.rawText).slice(0, 500)}`,
    );
  }

  return {
    snapshotId,
    requestUrl: url,
    requestBody: params.rows,
    responseStatus: result.status,
    responseBody: result.json,
    latencyMs: result.latencyMs,
  };
}

export type BrightDataJobStatus = "starting" | "running" | "ready" | "failed" | "unknown";

export interface BrightDataProgress {
  status: BrightDataJobStatus;
  raw: unknown;
}

export async function getProgress(snapshotId: string, apiToken: string): Promise<BrightDataProgress> {
  const url = `${BASE_URL}/progress/${encodeURIComponent(snapshotId)}`;
  const result = await fetchJson<{ status?: string }>(url, {
    method: "GET",
    headers: authHeaders(apiToken),
    timeoutMs: 15_000,
  });
  const status = (result.json?.status ?? "unknown") as BrightDataJobStatus;
  return { status, raw: result.json };
}

export async function getSnapshot(snapshotId: string, apiToken: string): Promise<unknown[]> {
  const url = `${BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const result = await fetchJson<unknown>(url, {
    method: "GET",
    headers: authHeaders(apiToken),
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`Bright Data snapshot fetch failed: status=${result.status}`);
  }
  return Array.isArray(result.json) ? result.json : [];
}

export interface PollResult {
  finalStatus: BrightDataJobStatus;
  pollCount: number;
  submittedAt: number;
  readyAt: number | null;
  totalLatencyMs: number;
}

export async function pollUntilReady(
  snapshotId: string,
  apiToken: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<PollResult> {
  const { intervalMs = 10_000, timeoutMs = 5 * 60_000 } = options;
  const submittedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - submittedAt < timeoutMs) {
    pollCount += 1;
    const progress = await getProgress(snapshotId, apiToken);
    if (progress.status === "ready" || progress.status === "failed") {
      const readyAt = Date.now();
      return {
        finalStatus: progress.status,
        pollCount,
        submittedAt,
        readyAt,
        totalLatencyMs: readyAt - submittedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    finalStatus: "unknown",
    pollCount,
    submittedAt,
    readyAt: null,
    totalLatencyMs: Date.now() - submittedAt,
  };
}

/**
 * Best-effort default discovery input row — UNVERIFIED against a real
 * dataset (see module doc comment). The orchestrator logs this in full
 * (sanitized) next to the response so a human can adjust field names for
 * the account's actual dataset schema before relying on results.
 */
export function buildHashtagDiscoveryInput(hashtag: string, limit: number): Record<string, unknown> {
  return {
    hashtag: hashtag.replace(/^#/, ""),
    num_of_posts: limit,
  };
}

export function buildCollectByUrlInput(url: string): Record<string, unknown> {
  return { url };
}
