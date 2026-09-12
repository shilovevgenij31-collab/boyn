import { describe, expect, it } from "vitest";
import { checkAvailability, collectSecretValues } from "../../scripts/provider-spike/env.ts";
import type { SpikeCredentials } from "../../scripts/provider-spike/env.ts";

describe("checkAvailability", () => {
  it("marks every combination unavailable when no credentials are configured", () => {
    const creds: SpikeCredentials = { brightData: null, apify: null };
    const availability = checkAvailability(creds);
    expect(availability.brightdataTiktok).toEqual({
      available: false,
      reason: "NO_API_TOKEN",
      detail: "BRIGHTDATA_API_TOKEN is not set",
    });
    expect(availability.apifyInstagram.available).toBe(false);
  });

  it("requires the specific dataset id, not just the Bright Data token", () => {
    const creds: SpikeCredentials = {
      brightData: { apiToken: "tok", datasetTikTokPosts: "ds_tiktok" }, // no IG dataset
      apify: null,
    };
    const availability = checkAvailability(creds);
    expect(availability.brightdataTiktok.available).toBe(true);
    expect(availability.brightdataInstagram).toEqual({
      available: false,
      reason: "NO_DATASET_ID",
      detail: "BRIGHTDATA_DATASET_INSTAGRAM_POSTS is not set",
    });
  });

  it("requires the specific actor id, not just the Apify token", () => {
    const creds: SpikeCredentials = {
      brightData: null,
      apify: { apiToken: "tok", actorTikTok: "clockworks/tiktok-scraper" }, // no IG actor
    };
    const availability = checkAvailability(creds);
    expect(availability.apifyTiktok.available).toBe(true);
    expect(availability.apifyInstagram).toEqual({
      available: false,
      reason: "NO_ACTOR_ID",
      detail: "APIFY_ACTOR_INSTAGRAM is not set",
    });
  });

  it("marks everything available when fully configured", () => {
    const creds: SpikeCredentials = {
      brightData: { apiToken: "tok", datasetTikTokPosts: "a", datasetInstagramPosts: "b" },
      apify: { apiToken: "tok", actorTikTok: "x", actorInstagram: "y" },
    };
    const availability = checkAvailability(creds);
    expect(Object.values(availability).every((a) => a.available)).toBe(true);
  });
});

describe("collectSecretValues", () => {
  it("collects only configured tokens, never derived/guessed values", () => {
    const creds: SpikeCredentials = {
      brightData: { apiToken: "bd-token-value" },
      apify: null,
    };
    expect(collectSecretValues(creds)).toEqual(["bd-token-value"]);
  });

  it("returns an empty array when nothing is configured", () => {
    expect(collectSecretValues({ brightData: null, apify: null })).toEqual([]);
  });
});
