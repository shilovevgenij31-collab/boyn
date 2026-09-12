import { describe, expect, it } from "vitest";
import { BRIGHTDATA_DISCOVERY_QUERY, buildBrightDataTikTokDiscoveryInput } from "@/providers/brightdata/build-input.ts";

describe("buildBrightDataTikTokDiscoveryInput", () => {
  it("matches the Phase 1B-verified body shape exactly", () => {
    expect(buildBrightDataTikTokDiscoveryInput(["cosplay", "gaming"], 20)).toEqual({
      input: [
        { search_keyword: "#cosplay", country: "" },
        { search_keyword: "#gaming", country: "" },
      ],
      limit_per_input: 20,
    });
  });

  it("re-adds the leading # (the verified example keeps it)", () => {
    const body = buildBrightDataTikTokDiscoveryInput(["ps5"], 20);
    expect(body.input[0]?.search_keyword).toBe("#ps5");
  });
});

describe("BRIGHTDATA_DISCOVERY_QUERY", () => {
  it("matches the verified query params exactly", () => {
    expect(BRIGHTDATA_DISCOVERY_QUERY).toEqual({
      notify: "false",
      type: "discover_new",
      discover_by: "keyword",
    });
  });
});
