import { describe, expect, it } from "vitest";
import {
  buildApifyInstagramDiscoveryInput,
  buildApifyTikTokDiscoveryInput,
  buildApifyTikTokRefreshInput,
} from "@/providers/apify/build-input.ts";

describe("buildApifyTikTokDiscoveryInput", () => {
  it("uses exactly the Phase 1B-verified search mode", () => {
    const body = buildApifyTikTokDiscoveryInput(["cosplay", "gaming"], 20);
    expect(body).toEqual({
      searchQueries: ["cosplay", "gaming"],
      searchSection: "/video",
      videoSearchSorting: "LATEST",
      videoSearchDateFilter: "PAST_24_HOURS",
      resultsPerPage: 20,
    });
  });

  it("NEVER regresses to the rejected hashtags + profileSorting mode", () => {
    const body = buildApifyTikTokDiscoveryInput(["cosplay"], 20);
    expect(body).not.toHaveProperty("hashtags");
    expect(body).not.toHaveProperty("profileSorting");
  });

  it("does not silently re-add a '#' — queries are passed through as given (already normalized by the caller)", () => {
    const body = buildApifyTikTokDiscoveryInput(["cosplay"], 20) as { searchQueries: string[] };
    expect(body.searchQueries).toEqual(["cosplay"]);
  });
});

describe("buildApifyTikTokRefreshInput", () => {
  it("uses the verified postURLs field", () => {
    expect(buildApifyTikTokRefreshInput(["https://www.tiktok.com/@u/video/1"])).toEqual({
      postURLs: ["https://www.tiktok.com/@u/video/1"],
    });
  });
});

describe("buildApifyInstagramDiscoveryInput", () => {
  it("uses the verified hashtags/resultsType/resultsLimit fields", () => {
    expect(buildApifyInstagramDiscoveryInput(["cosplay"], 20)).toEqual({
      hashtags: ["cosplay"],
      resultsType: "reels",
      resultsLimit: 20,
    });
  });

  it("never includes a date/recency filter field (confirmed absent from the actor)", () => {
    const body = buildApifyInstagramDiscoveryInput(["cosplay"], 20);
    expect(Object.keys(body).some((k) => /date|recency|sort/i.test(k))).toBe(false);
  });
});
