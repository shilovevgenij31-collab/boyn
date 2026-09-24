/**
 * Conservative per-record cost estimate (Phase 8/9 hotfix Part D
 * production incident: provider_jobs.cost_est_usd was never written, so
 * /status's budget ledger silently read as $0 regardless of real usage).
 */
import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "@/providers/cost.ts";

describe("estimateCostUsd", () => {
  it("returns 0 for zero records", () => {
    expect(estimateCostUsd("apify", 0)).toBe("0.000000");
  });

  it("uses Apify's documented ≈$2.3/1K rate", () => {
    expect(estimateCostUsd("apify", 1000)).toBe("2.300000");
    expect(estimateCostUsd("apify", 16)).toBe("0.036800");
  });

  it("uses Bright Data's documented ≈$1.50/1K rate", () => {
    expect(estimateCostUsd("brightdata", 1000)).toBe("1.500000");
    expect(estimateCostUsd("brightdata", 90)).toBe("0.135000");
  });

  it("returns a numeric-column-safe string, never a bare float", () => {
    const result = estimateCostUsd("apify", 7);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^\d+\.\d{6}$/);
  });
});
