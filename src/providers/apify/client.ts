/**
 * Production Apify REST client. Knows the HTTP surface (run/status/
 * dataset/abort), nothing about TikTok/Instagram or our discovery
 * intent — that translation lives in provider.ts.
 *
 * Endpoints verified in Phase 1/1B (docs/PROVIDER_SPIKE.md):
 *   POST /v2/acts/{actorId}/runs        -> { data: { id, defaultDatasetId, status } }
 *   GET  /v2/actor-runs/{runId}         -> { data: { status, defaultDatasetId, ... } }
 *   GET  /v2/datasets/{datasetId}/items -> array of items
 *   POST /v2/actor-runs/{runId}/abort   -> (documented Apify endpoint, not exercised live
 *                                           in the spike — implemented here for the
 *                                           interface's optional `cancel`, not required
 *                                           to have been smoke-tested to be safe: it's a
 *                                           standard idempotent-ish abort call.)
 */
import { providerFetch } from "../http.ts";
import { ProviderError } from "../errors.ts";

const BASE_URL = "https://api.apify.com/v2";
const PROVIDER = "apify";

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

export interface ApifyRunResult {
  runId: string;
  defaultDatasetId: string;
  latencyMs: number;
}

interface ApifyRunResponse {
  data?: { id?: string; defaultDatasetId?: string; status?: string };
}

export async function runActor(
  actorId: string,
  apiToken: string,
  input: Record<string, unknown>,
): Promise<ApifyRunResult> {
  const url = `${BASE_URL}/acts/${encodeURIComponent(actorId)}/runs`;
  const result = await providerFetch<ApifyRunResponse>(url, {
    provider: PROVIDER,
    operation: "runActor",
    method: "POST",
    headers: authHeaders(apiToken),
    body: input,
    timeoutMs: 30_000,
  });

  const runId = result.json?.data?.id;
  const defaultDatasetId = result.json?.data?.defaultDatasetId;
  if (!runId || !defaultDatasetId) {
    throw new ProviderError(
      "UPSTREAM",
      PROVIDER,
      "runActor",
      "Apify run response missing data.id/data.defaultDatasetId",
      { httpStatus: result.status },
    );
  }
  return { runId, defaultDatasetId, latencyMs: result.latencyMs };
}

export type ApifyVendorStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED-OUT"
  | "ABORTED"
  | "ABORTING"
  | "UNKNOWN";

export interface ApifyRunInfo {
  status: ApifyVendorStatus;
  defaultDatasetId: string | null;
}

export async function getRunInfo(runId: string, apiToken: string): Promise<ApifyRunInfo> {
  const url = `${BASE_URL}/actor-runs/${encodeURIComponent(runId)}`;
  const result = await providerFetch<ApifyRunResponse>(url, {
    provider: PROVIDER,
    operation: "getRunInfo",
    headers: authHeaders(apiToken),
    timeoutMs: 15_000,
  });
  return {
    status: (result.json?.data?.status as ApifyVendorStatus) ?? "UNKNOWN",
    defaultDatasetId: result.json?.data?.defaultDatasetId ?? null,
  };
}

export async function getDatasetItems(datasetId: string, apiToken: string): Promise<unknown[]> {
  const url = `${BASE_URL}/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true`;
  const result = await providerFetch<unknown>(url, {
    provider: PROVIDER,
    operation: "getDatasetItems",
    headers: authHeaders(apiToken),
    timeoutMs: 30_000,
  });
  return Array.isArray(result.json) ? result.json : [];
}

export async function abortRun(runId: string, apiToken: string): Promise<void> {
  const url = `${BASE_URL}/actor-runs/${encodeURIComponent(runId)}/abort`;
  await providerFetch(url, {
    provider: PROVIDER,
    operation: "abortRun",
    method: "POST",
    headers: authHeaders(apiToken),
    timeoutMs: 15_000,
  });
}
