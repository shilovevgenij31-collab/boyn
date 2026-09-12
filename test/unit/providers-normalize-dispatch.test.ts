import { describe, expect, it } from "vitest";
import { normalizeProviderPost } from "@/providers/normalize.ts";
import { loadFixture } from "./helpers/fixtures.ts";

const CONTEXT = { observedAt: new Date("2026-09-12T18:00:00.000Z"), discoveryMethod: "search" };

describe("normalizeProviderPost dispatch", () => {
  it("routes apify/tiktok to the Apify TikTok normalizer", () => {
    const raw = loadFixture("apify/tiktok/search-1.json");
    const result = normalizeProviderPost({ provider: "apify", platform: "tiktok", raw, context: CONTEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.source.provider).toBe("apify");
    expect(result.post.platform).toBe("tiktok");
  });

  it("routes apify/instagram to the Apify Instagram normalizer", () => {
    const raw = loadFixture("apify/instagram/sample-1.json");
    const result = normalizeProviderPost({ provider: "apify", platform: "instagram", raw, context: CONTEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.platform).toBe("instagram");
  });

  it("routes brightdata/tiktok to the Bright Data TikTok normalizer", () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json");
    const result = normalizeProviderPost({ provider: "brightdata", platform: "tiktok", raw, context: CONTEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.source.provider).toBe("brightdata");
  });

  it("returns an explicit UNSUPPORTED result for brightdata/instagram, never throws", () => {
    const result = normalizeProviderPost({
      provider: "brightdata",
      platform: "instagram",
      raw: { anything: "at all" },
      context: CONTEXT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("UNSUPPORTED");
  });

  it("propagates a malformed-item failure instead of throwing, for every routed combination", () => {
    for (const provider of ["apify", "brightdata"] as const) {
      for (const platform of ["tiktok", "instagram"] as const) {
        expect(() =>
          normalizeProviderPost({ provider, platform, raw: "garbage", context: CONTEXT }),
        ).not.toThrow();
      }
    }
  });
});
