import { describe, expect, it } from "vitest";
import {
  computeNextRefreshAt,
  isRefreshDue,
  isRefreshEligible,
  type RefreshCandidate,
} from "@/core/scheduling/refresh-planner.ts";

const now = new Date("2026-09-12T13:00:00.000Z");

function post(overrides: Partial<RefreshCandidate> = {}): RefreshCandidate {
  return {
    postId: 1,
    publishedAt: new Date("2026-09-12T06:00:00.000Z"), // 7h old
    views: 10_000,
    paidRefreshCount: 0,
    nextRefreshAt: null,
    availability: "ACTIVE",
    ...overrides,
  };
}

describe("isRefreshEligible", () => {
  it("is eligible: ACTIVE, enough views, recent enough, under the refresh cap", () => {
    expect(isRefreshEligible(post(), now)).toBe(true);
  });

  it("rejects non-ACTIVE availability", () => {
    expect(isRefreshEligible(post({ availability: "DELETED" }), now)).toBe(false);
  });

  it("rejects at/over the max paid refresh count", () => {
    expect(isRefreshEligible(post({ paidRefreshCount: 3 }), now)).toBe(false);
  });

  it("rejects null or below-threshold views (missing != zero engagement, but still not refresh-worthy)", () => {
    expect(isRefreshEligible(post({ views: null }), now)).toBe(false);
    expect(isRefreshEligible(post({ views: 100 }), now)).toBe(false);
  });

  it("rejects a null publishedAt", () => {
    expect(isRefreshEligible(post({ publishedAt: null }), now)).toBe(false);
  });

  it("rejects a post older than the max age", () => {
    expect(isRefreshEligible(post({ publishedAt: new Date("2026-09-01T00:00:00.000Z") }), now)).toBe(false);
  });

  it("rejects a publishedAt in the future (clock skew guard)", () => {
    expect(isRefreshEligible(post({ publishedAt: new Date("2026-09-13T00:00:00.000Z") }), now)).toBe(false);
  });
});

describe("isRefreshDue", () => {
  it("is due when eligible and nextRefreshAt is null (never refreshed)", () => {
    expect(isRefreshDue(post({ nextRefreshAt: null }), now)).toBe(true);
  });

  it("is due when nextRefreshAt is in the past", () => {
    expect(isRefreshDue(post({ nextRefreshAt: new Date("2026-09-12T12:00:00.000Z") }), now)).toBe(true);
  });

  it("is NOT due when nextRefreshAt is in the future", () => {
    expect(isRefreshDue(post({ nextRefreshAt: new Date("2026-09-12T18:00:00.000Z") }), now)).toBe(false);
  });

  it("is never due when ineligible, regardless of nextRefreshAt", () => {
    expect(isRefreshDue(post({ availability: "DELETED", nextRefreshAt: new Date("2026-01-01") }), now)).toBe(false);
  });
});

describe("computeNextRefreshAt", () => {
  it("adds the configured step in hours", () => {
    const next = computeNextRefreshAt(now);
    expect(next.getTime() - now.getTime()).toBe(6 * 3_600_000);
  });
});
