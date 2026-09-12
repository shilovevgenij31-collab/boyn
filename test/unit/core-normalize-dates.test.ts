import { describe, expect, it } from "vitest";
import { parseProviderDate } from "@/core/normalize/dates.ts";

describe("parseProviderDate", () => {
  it("parses an ISO 8601 string (Apify createTimeISO / Bright Data create_time)", () => {
    const d = parseProviderDate("2026-09-12T16:49:57.000Z");
    expect(d?.toISOString()).toBe("2026-09-12T16:49:57.000Z");
  });

  it("parses unix seconds as a number (Apify createTime)", () => {
    const d = parseProviderDate(1789231797);
    expect(d?.getTime()).toBe(1789231797 * 1000);
  });

  it("parses a numeric string the same way as a number", () => {
    const d = parseProviderDate("1789231797");
    expect(d?.getTime()).toBe(1789231797 * 1000);
  });

  it("passes through a Date instance", () => {
    const input = new Date("2026-01-01T00:00:00.000Z");
    expect(parseProviderDate(input)).toBe(input);
  });

  it("returns null for garbage rather than a fabricated date", () => {
    expect(parseProviderDate("not a date")).toBeNull();
    expect(parseProviderDate(undefined)).toBeNull();
    expect(parseProviderDate(null)).toBeNull();
    expect(parseProviderDate({})).toBeNull();
    expect(parseProviderDate("")).toBeNull();
  });

  it("returns null for an invalid Date instance", () => {
    expect(parseProviderDate(new Date("garbage"))).toBeNull();
  });

  it("returns null for NaN/Infinity numbers", () => {
    expect(parseProviderDate(NaN)).toBeNull();
    expect(parseProviderDate(Infinity)).toBeNull();
  });
});
