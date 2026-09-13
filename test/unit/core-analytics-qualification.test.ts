import { describe, expect, it } from "vitest";
import { classifyPostTier, type QualificationInput } from "@/core/analytics/qualification.ts";

function base(overrides: Partial<QualificationInput> = {}): QualificationInput {
  return {
    views: 1000,
    publishedAt: new Date("2026-09-12T00:00:00.000Z"),
    contentType: "video",
    availability: "ACTIVE",
    ageHours: 10,
    vph: 100,
    vphConfidence: "MEDIUM",
    comments: 10,
    shares: 15,
    ...overrides,
  };
}

describe("classifyPostTier — data-quality exclusion", () => {
  it("null views -> excluded (tier null)", () => {
    expect(classifyPostTier(base({ views: null })).tier).toBeNull();
  });
  it("null publishedAt -> excluded", () => {
    expect(classifyPostTier(base({ publishedAt: null })).tier).toBeNull();
  });
  it("non-video content -> excluded", () => {
    expect(classifyPostTier(base({ contentType: "image" })).tier).toBeNull();
  });
  it("unavailable post -> excluded", () => {
    expect(classifyPostTier(base({ availability: "DELETED" })).tier).toBeNull();
  });
});

describe("classifyPostTier — EARLY_BREAKOUT", () => {
  it("qualifies with age/views/vph in range and engagement floor cleared", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 25_000, vph: 12_000, vphConfidence: "MEDIUM", comments: 10, shares: 5 }));
    expect(result.tier).toBe("EARLY_BREAKOUT");
    expect(result.isEarlyBreakoutEligible).toBe(true);
  });

  it("does not require full engagement metrics — missing both still qualifies (floor skipped, confidence capped)", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 25_000, vph: 12_000, vphConfidence: "MEDIUM", comments: null, shares: null }));
    expect(result.tier).toBe("EARLY_BREAKOUT");
    expect(result.confidenceCap).toBe("MEDIUM");
  });

  it("LOW confidence still qualifies if views clear the high floor (50k)", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 60_000, vph: 12_000, vphConfidence: "LOW", comments: 10, shares: 15 }));
    expect(result.isEarlyBreakoutEligible).toBe(true);
  });

  it("LOW confidence with views under the floor does not qualify", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 25_000, vph: 12_000, vphConfidence: "LOW", comments: 10, shares: 15 }));
    expect(result.isEarlyBreakoutEligible).toBe(false);
  });

  it("outside the age window does not qualify", () => {
    const tooYoung = classifyPostTier(base({ ageHours: 0.1, views: 25_000, vph: 12_000 }));
    const tooOld = classifyPostTier(base({ ageHours: 10, views: 25_000, vph: 12_000 }));
    expect(tooYoung.isEarlyBreakoutEligible).toBe(false);
    expect(tooOld.isEarlyBreakoutEligible).toBe(false);
  });

  it("engagement floor rejects a glitchy view spike with no engagement at all when confidence is already MEDIUM+", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 25_000, vph: 12_000, vphConfidence: "MEDIUM", comments: 1, shares: 2 }));
    expect(result.isEarlyBreakoutEligible).toBe(false);
  });
});

describe("classifyPostTier — VIRAL_QUALIFIED takes precedence but keeps the breakout flag", () => {
  it("a post clearing BOTH EARLY_BREAKOUT and VIRAL_QUALIFIED is labelled VIRAL_QUALIFIED with the flag set", () => {
    const result = classifyPostTier(base({ ageHours: 2, views: 150_000, vph: 20_000, vphConfidence: "HIGH", comments: 20, shares: 30 }));
    expect(result.tier).toBe("VIRAL_QUALIFIED");
    expect(result.isEarlyBreakoutEligible).toBe(true);
  });
});

describe("classifyPostTier — WATCH and NOISE", () => {
  it("WATCH: modest but real traction within 24h", () => {
    const result = classifyPostTier(base({ ageHours: 20, views: 6_000, vph: 2_000 }));
    expect(result.tier).toBe("WATCH");
  });

  it("NOISE: everything else", () => {
    const result = classifyPostTier(base({ ageHours: 20, views: 100, vph: 10 }));
    expect(result.tier).toBe("NOISE");
  });
});
