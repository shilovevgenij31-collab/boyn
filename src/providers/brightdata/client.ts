/**
 * Production Bright Data "Web Scraper API" (datasets v3) REST client.
 * HTTP surface only — no business decisions here (e.g. whether a
 * synchronous response is acceptable in production is decided by
 * provider.ts, not this module).
 *
 * Verified against the live account in Phase 1/1B (docs/PROVIDER_SPIKE.md):
 *   POST /datasets/v3/scrape?dataset_id=...&notify=false&include_errors=true
 *        &type=discover_new&discover_by=keyword
 *     body: { "input": [{ "search_keyword": "#cosplay", "country": "" }, ...],
 *             "limit_per_input": N }
 *     -> usually HTTP 202 { "snapshot_id": "..." } (observed 60-370s to respond)
 *   GET  /datasets/v3/progress/{snapshot_id} -> { status: starting|running|ready|failed }
 *   GET  /datasets/v3/snapshot/{snapshot_id}?format=json -> array of records
 */
import { providerFetch } from "../http.ts";
import { ProviderError } from "../errors.ts";

const BASE_URL = "https://api.brightdata.com/datasets/v3";
const PROVIDER = "brightdata";

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

export interface SubmitResult {
  /** Present when the job is async (the observed production path). */
  snapshotId: string | null;
  /** Present only if the endpoint ever returns results directly — never
   * observed for our real job sizes in Phase 1/1B, but the client still
   * reports it honestly rather than assuming it can't happen. */
  directRecords: unknown[] | null;
  latencyMs: number;
}

export async function submitDiscovery(params: {
  datasetId: string;
  apiToken: string;
  body: unknown;
  extraQuery: Record<string, string>;
}): Promise<SubmitResult> {
  const query = new URLSearchParams({ dataset_id: params.datasetId, include_errors: "true", ...params.extraQuery });
  const url = `${BASE_URL}/scrape?${query.toString()}`;

  try {
    const result = await providerFetch<unknown>(url, {
      provider: PROVIDER,
      operation: "submitDiscovery",
      method: "POST",
      headers: authHeaders(params.apiToken),
      body: params.body,
      // Empirically 60-370s to respond (Phase 1B) — a short timeout produces
      // a FALSE failure, not a real one. maxAttempts: 1 is deliberate: a
      // client-side abort here most likely means the job is still running
      // server-side, so retrying risks submitting (and billing) a duplicate.
      timeoutMs: 120_000,
      maxAttempts: 1,
    });
    return parseSubmitResponse(result.json, result.latencyMs);
  } catch (error) {
    throw reclassifyKnownAccountError(error);
  }
}

/**
 * Phase 1B observed Bright Data returning HTTP 400 "Customer is not
 * active" for an inactive/unpaid account — a real account-status
 * problem, not a malformed request. http.ts's generic status-based
 * mapping would call that BAD_INPUT (wrong: retrying with different
 * input can never fix it) or worse imply a client bug; QUOTA is the
 * accurate classification, and it's what governs the circuit breaker's
 * "don't reopen on retry" behavior for exactly this case.
 */
function reclassifyKnownAccountError(error: unknown): unknown {
  if (error instanceof ProviderError && /customer is not active/i.test(error.message)) {
    return new ProviderError("QUOTA", PROVIDER, error.operation, error.message, {
      httpStatus: error.httpStatus ?? undefined,
      cause: error,
    });
  }
  return error;
}

function parseSubmitResponse(json: unknown, latencyMs: number): SubmitResult {
  if (Array.isArray(json)) {
    return { snapshotId: null, directRecords: json, latencyMs };
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (typeof obj.snapshot_id === "string") {
      return { snapshotId: obj.snapshot_id, directRecords: null, latencyMs };
    }
    if (Array.isArray(obj.data)) return { snapshotId: null, directRecords: obj.data, latencyMs };
    if (Array.isArray(obj.results)) return { snapshotId: null, directRecords: obj.results, latencyMs };
  }
  throw new ProviderError(
    "UPSTREAM",
    PROVIDER,
    "submitDiscovery",
    "response shape not recognized (no snapshot_id, not an array, no data/results array)",
  );
}

export type BrightDataVendorStatus = "starting" | "running" | "ready" | "failed" | "unknown";

export async function getProgress(snapshotId: string, apiToken: string): Promise<BrightDataVendorStatus> {
  const url = `${BASE_URL}/progress/${encodeURIComponent(snapshotId)}`;
  const result = await providerFetch<{ status?: string }>(url, {
    provider: PROVIDER,
    operation: "getProgress",
    headers: authHeaders(apiToken),
    timeoutMs: 15_000,
  });
  return (result.json?.status as BrightDataVendorStatus) ?? "unknown";
}

export async function getSnapshot(snapshotId: string, apiToken: string): Promise<unknown[]> {
  const url = `${BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const result = await providerFetch<unknown>(url, {
    provider: PROVIDER,
    operation: "getSnapshot",
    headers: authHeaders(apiToken),
    timeoutMs: 30_000,
  });
  return Array.isArray(result.json) ? result.json : [];
}
