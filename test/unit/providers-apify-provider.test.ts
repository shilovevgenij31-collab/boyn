import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApifyProvider } from "@/providers/apify/provider.ts";
import { ProviderError } from "@/providers/errors.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("ApifyProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: ApifyProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    provider = new ApifyProvider({ apiToken: "test-token", actorTikTok: "actor/tiktok", actorInstagram: "actor/ig" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("capabilities: tiktok discovery+refresh, instagram discovery only, both with explicit attribution known only where verified", () => {
    const cap = provider.capabilities();
    expect(cap.tiktok).toEqual({ discovery: true, refreshByUrl: true, multiQueryAttribution: true });
    expect(cap.instagram).toEqual({ discovery: true, refreshByUrl: false, multiQueryAttribution: false });
  });

  it("submitDiscovery for tiktok posts to the actorTikTok actor with the verified search body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { data: { id: "run1", defaultDatasetId: "ds1" } }));
    const result = await provider.submitDiscovery({
      platform: "tiktok",
      market: "global",
      queries: [{ query: "cosplay" }],
      limitPerQuery: 20,
    });

    expect(result.externalJobId).toBe("run1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/acts/actor%2Ftiktok/runs");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ searchQueries: ["cosplay"], searchSection: "/video", videoSearchSorting: "LATEST" });
  });

  it("submitDiscovery for instagram posts to the actorInstagram actor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { data: { id: "run2", defaultDatasetId: "ds2" } }));
    await provider.submitDiscovery({
      platform: "instagram",
      market: "global",
      queries: [{ query: "cosplay" }],
      limitPerQuery: 20,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/acts/actor%2Fig/runs");
  });

  it("submitRefresh for instagram is explicitly UNSUPPORTED (no network call made)", async () => {
    await expect(
      provider.submitRefresh({ platform: "instagram", posts: [{ externalId: "1", canonicalUrl: "https://x" }] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submitRefresh for tiktok uses postURLs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { data: { id: "run3", defaultDatasetId: "ds3" } }));
    await provider.submitRefresh({
      platform: "tiktok",
      posts: [{ externalId: "1", canonicalUrl: "https://www.tiktok.com/@u/video/1" }],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ postURLs: ["https://www.tiktok.com/@u/video/1"] });
  });

  it("maps vendor status SUCCEEDED to READY (not RUNNING — Apify's own 'READY' means queued, a false friend)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { status: "SUCCEEDED", defaultDatasetId: "ds1" } }));
    const status = await provider.getStatus("run1");
    expect(status.state).toBe("READY");
  });

  it("maps vendor status READY (queued) to our RUNNING, not READY", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { status: "READY" } }));
    const status = await provider.getStatus("run1");
    expect(status.state).toBe("RUNNING");
  });

  it("maps FAILED/TIMED-OUT/ABORTED to FAILED", async () => {
    for (const vendorStatus of ["FAILED", "TIMED-OUT", "ABORTED"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { status: vendorStatus } }));
      const status = await provider.getStatus("run1");
      expect(status.state).toBe("FAILED");
    }
  });

  it("fetchResults resolves the dataset id from the run, then fetches items", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { status: "SUCCEEDED", defaultDatasetId: "ds1" } }))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "1" }, { id: "2" }]));

    const page = await provider.fetchResults("run1");
    expect(page.items).toEqual([{ id: "1" }, { id: "2" }]);
    expect(page.truncated).toBe(false);
    const [datasetUrl] = fetchMock.mock.calls[1] as [string];
    expect(datasetUrl).toContain("/datasets/ds1/items");
  });

  it("cancel calls the abort endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await provider.cancel("run1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/actor-runs/run1/abort");
    expect(init.method).toBe("POST");
  });

  it("throws a clear ProviderError when the run response is missing required fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await expect(
      provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 }),
    ).rejects.toThrow(ProviderError);
  });
});
