import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrightDataProvider } from "@/providers/brightdata/provider.ts";
import { ProviderError } from "@/providers/errors.ts";
import type { SocialDataProvider } from "@/providers/provider.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("BrightDataProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: BrightDataProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    provider = new BrightDataProvider({ apiToken: "test-token", datasetTikTokPosts: "gd_test123" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("capabilities: tiktok discovery only, no refresh, no instagram", () => {
    const cap = provider.capabilities();
    expect(cap.tiktok).toEqual({ discovery: true, refreshByUrl: false, multiQueryAttribution: true });
    expect(cap.instagram).toEqual({ discovery: false, refreshByUrl: false, multiQueryAttribution: false });
  });

  it("submitDiscovery for instagram is explicitly UNSUPPORTED (no network call made)", async () => {
    await expect(
      provider.submitDiscovery({ platform: "instagram", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submitRefresh is UNSUPPORTED for every platform (out of Phase 4 scope)", async () => {
    await expect(
      provider.submitRefresh({ platform: "tiktok", posts: [{ externalId: "1", canonicalUrl: "https://x" }] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submitDiscovery posts the verified keyword-discovery request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { snapshot_id: "sd_abc" }));
    const result = await provider.submitDiscovery({
      platform: "tiktok",
      market: "global",
      queries: [{ query: "cosplay" }],
      limitPerQuery: 20,
    });
    expect(result.externalJobId).toBe("sd_abc");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("dataset_id=gd_test123");
    expect(url).toContain("type=discover_new");
    expect(url).toContain("discover_by=keyword");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ input: [{ search_keyword: "#cosplay", country: "" }], limit_per_input: 20 });
  });

  it("throws (does not silently accept) a synchronous direct-array response — never observed in production", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ post_id: "1" }]));
    await expect(
      provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 }),
    ).rejects.toThrow(ProviderError);
  });

  it("reclassifies the real Phase 1B 'Customer is not active' error as QUOTA, not BAD_INPUT", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "Customer is not active" }));
    await expect(
      provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 }),
    ).rejects.toMatchObject({ code: "QUOTA" });
  });

  it("maps starting/running to RUNNING, ready to READY, failed to FAILED", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "starting" }));
    expect((await provider.getStatus("sd_1")).state).toBe("RUNNING");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "running" }));
    expect((await provider.getStatus("sd_1")).state).toBe("RUNNING");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "ready" }));
    expect((await provider.getStatus("sd_1")).state).toBe("READY");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "failed" }));
    expect((await provider.getStatus("sd_1")).state).toBe("FAILED");
  });

  it("an ambiguous/unknown status is NEVER treated as FAILED (the exact Phase 1B false-negative)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const status = await provider.getStatus("sd_1");
    expect(status.state).toBe("RUNNING");
  });

  it("fetchResults returns the snapshot's records", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ post_id: "1" }, { post_id: "2" }]));
    const page = await provider.fetchResults("sd_1");
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(false);
  });

  it("has no cancel() — Bright Data cancellation was never verified", () => {
    expect((provider as SocialDataProvider).cancel).toBeUndefined();
  });
});
