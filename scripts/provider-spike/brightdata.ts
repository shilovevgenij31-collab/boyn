/**
 * Minimal Bright Data "Web Scraper API" (datasets v3) REST client for the
 * Phase 1 spike.
 *
 * VERIFIED against the live Bright Data account (manually inspected in the
 * Scrapers UI, TikTok - Posts dataset gd_lu702nij2f790tmv9h) — not a
 * documentation guess:
 *
 *   Discover by keyword:
 *     POST /datasets/v3/scrape
 *       ?dataset_id=gd_lu702nij2f790tmv9h&notify=false&include_errors=true
 *        &type=discover_new&discover_by=keyword
 *     body: { "input": [{ "search_keyword": "#cosplay", "country": "" }, ...],
 *             "limit_per_input": 20 }
 *
 *   Collect by URL:
 *     POST /datasets/v3/scrape?dataset_id=gd_lu702nij2f790tmv9h&include_errors=true
 *     body: { "input": [{ "url": "https://www.tiktok.com/@user/video/123" }] }
 *
 * Both hit the same `/scrape` path (not `/trigger`, contrary to earlier
 * secondary-source research — corrected here). The general async
 * trigger/progress/snapshot mechanics from Phase 0 research (snapshot_id ->
 * poll progress -> fetch snapshot) are assumed to still apply, but `submit()`
 * below also tolerates a direct/synchronous array response, since it's
 * genuinely unclear which this account's `/scrape` path returns for a small
 * job until we've actually called it once.
 *
 * Instagram: NOT verified to have a first-class hashtag discovery endpoint
 * on this account (Reels/Posts expose Collect by URL / Discover by URL /
 * Discover by URL all reels — URL-shaped, not hashtag-shaped). No Instagram
 * client code here; Instagram discovery for Phase 1 goes through Apify.
 */
import { fetchJson } from "./http.ts";

const BASE_URL = "https://api.brightdata.com/datasets/v3";

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

export interface SubmitParams {
  datasetId: string;
  apiToken: string;
  /** Exact request body — caller controls the shape, nothing is re-wrapped here. */
  body: unknown;
  /** Extra query params beyond dataset_id/include_errors, e.g. discovery mode flags. */
  extraQuery?: Record<string, string>;
}

export interface SubmitResult {
  /** Present when the job is async and needs polling. */
  snapshotId: string | null;
  /** Present when the endpoint returned results directly (synchronous). */
  directRecords: unknown[] | null;
  requestUrl: string;
  requestBody: unknown;
  responseStatus: number;
  latencyMs: number;
}

/** POSTs to /scrape and figures out, from the actual response shape,
 * whether this was an async job (snapshot_id) or a direct/sync result
 * (an array, or a wrapper object with an array `data`/`results` field). */
export async function submit(params: SubmitParams): Promise<SubmitResult> {
  const query = new URLSearchParams({
    dataset_id: params.datasetId,
    include_errors: "true",
    ...params.extraQuery,
  });
  const url = `${BASE_URL}/scrape?${query.toString()}`;

  const result = await fetchJson<unknown>(url, {
    method: "POST",
    headers: authHeaders(params.apiToken),
    body: params.body,
    timeoutMs: 30_000,
  });

  if (!result.ok) {
    throw new Error(
      `Bright Data submit failed: status=${result.status} body=${JSON.stringify(result.json ?? result.rawText).slice(0, 500)}`,
    );
  }

  const json = result.json as Record<string, unknown> | unknown[] | null;
  let snapshotId: string | null = null;
  let directRecords: unknown[] | null = null;

  if (Array.isArray(json)) {
    directRecords = json;
  } else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (typeof obj.snapshot_id === "string") {
      snapshotId = obj.snapshot_id;
    } else if (Array.isArray(obj.data)) {
      directRecords = obj.data;
    } else if (Array.isArray(obj.results)) {
      directRecords = obj.results;
    }
  }

  if (snapshotId === null && directRecords === null) {
    throw new Error(
      `Bright Data submit: response shape not recognized (no snapshot_id, not an array, no data/results array). ` +
        `status=${result.status} body=${JSON.stringify(json).slice(0, 500)}`,
    );
  }

  return {
    snapshotId,
    directRecords,
    requestUrl: url,
    requestBody: params.body,
    responseStatus: result.status,
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

/** Verified body shape for "Discover by keyword" (see module doc comment).
 * `search_keyword` intentionally keeps the leading "#" — that's what the
 * verified example uses. */
export function buildTikTokKeywordDiscoveryBody(
  hashtags: string[],
  limitPerInput: number,
): { input: { search_keyword: string; country: string }[]; limit_per_input: number } {
  return {
    input: hashtags.map((h) => ({
      search_keyword: h.startsWith("#") ? h : `#${h}`,
      country: "",
    })),
    limit_per_input: limitPerInput,
  };
}

/** Verified body shape for "Collect by URL". */
export function buildCollectByUrlBody(urls: string[]): { input: { url: string }[] } {
  return { input: urls.map((url) => ({ url })) };
}
