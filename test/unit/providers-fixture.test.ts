import { describe, expect, it } from "vitest";
import { FixtureProvider } from "@/providers/fixture/provider.ts";
import { ProviderError } from "@/providers/errors.ts";

describe("FixtureProvider", () => {
  it("id is 'fixture', not a real persisted ProviderId", () => {
    const provider = new FixtureProvider({ jobs: [] });
    expect(provider.id).toBe("fixture");
  });

  it("a job with runningPolls:0 is READY on the very first poll", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 0, items: [{ a: 1 }] }] });
    const submitted = await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });
    const status = await provider.getStatus(submitted.externalJobId);
    expect(status.state).toBe("READY");
  });

  it("a job with runningPolls:2 reports RUNNING twice, then READY, deterministically", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 2, items: [{ a: 1 }] }] });
    const submitted = await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });

    expect((await provider.getStatus(submitted.externalJobId)).state).toBe("RUNNING");
    expect((await provider.getStatus(submitted.externalJobId)).state).toBe("RUNNING");
    expect((await provider.getStatus(submitted.externalJobId)).state).toBe("READY");
  });

  it("fetchResults returns exactly the configured items, deterministically, with no truncation", async () => {
    const items = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 0, items }] });
    const submitted = await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });
    const page = await provider.fetchResults(submitted.externalJobId);
    expect(page.items).toEqual(items);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("a job with failAfter reports FAILED once that poll count is reached", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 5, failAfter: 2, items: [] }] });
    const submitted = await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });

    expect((await provider.getStatus(submitted.externalJobId)).state).toBe("RUNNING");
    expect((await provider.getStatus(submitted.externalJobId)).state).toBe("FAILED");
  });

  it("throws a clear ProviderError when the planned job queue is exhausted — a test bug, not silently handled", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 0, items: [] }] });
    await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });
    await expect(
      provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "y" }], limitPerQuery: 5 }),
    ).rejects.toThrow(ProviderError);
  });

  it("getStatus/fetchResults on an unknown job id throws NOT_FOUND", async () => {
    const provider = new FixtureProvider({ jobs: [] });
    await expect(provider.getStatus("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.fetchResults("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("respects overridden capabilities — submitDiscovery/submitRefresh reject unsupported platforms", async () => {
    const provider = new FixtureProvider({
      capabilities: { instagram: { discovery: false, refreshByUrl: false, multiQueryAttribution: false } },
      jobs: [],
    });
    await expect(
      provider.submitDiscovery({ platform: "instagram", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("cancel removes the job so subsequent getStatus fails with NOT_FOUND", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 0, items: [] }] });
    const submitted = await provider.submitDiscovery({ platform: "tiktok", market: "global", queries: [{ query: "x" }], limitPerQuery: 5 });
    await provider.cancel(submitted.externalJobId);
    await expect(provider.getStatus(submitted.externalJobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("submitRefresh works through the same job queue and lifecycle as submitDiscovery", async () => {
    const provider = new FixtureProvider({ jobs: [{ runningPolls: 0, items: [{ id: "r1" }] }] });
    const submitted = await provider.submitRefresh({ platform: "tiktok", posts: [{ externalId: "1", canonicalUrl: "https://x" }] });
    const status = await provider.getStatus(submitted.externalJobId);
    expect(status.state).toBe("READY");
    const page = await provider.fetchResults(submitted.externalJobId);
    expect(page.items).toEqual([{ id: "r1" }]);
  });
});
