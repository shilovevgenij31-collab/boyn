import { describe, expect, it } from "vitest";
import { parseCount, parseDuration } from "@/core/normalize/numbers.ts";

describe("parseCount", () => {
  it("returns null for missing values, never 0", () => {
    expect(parseCount(null)).toBeNull();
    expect(parseCount(undefined)).toBeNull();
  });

  it("parses a plain number", () => {
    expect(parseCount(4854)).toBe(4854);
    expect(parseCount(0)).toBe(0);
  });

  it("parses a numeric string (e.g. Bright Data's share_count)", () => {
    expect(parseCount("9")).toBe(9);
    expect(parseCount("179")).toBe(179);
  });

  it("maps Instagram's -1 'hidden' sentinel to null, not -1 or 0", () => {
    expect(parseCount(-1)).toBeNull();
  });

  it("maps any negative number to null", () => {
    expect(parseCount(-100)).toBeNull();
  });

  it("rejects non-integer-looking strings", () => {
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("N/A")).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount("12abc")).toBeNull();
  });

  it("rejects NaN and Infinity", () => {
    expect(parseCount(NaN)).toBeNull();
    expect(parseCount(Infinity)).toBeNull();
    expect(parseCount(-Infinity)).toBeNull();
  });

  it("rejects non-numeric types", () => {
    expect(parseCount(true)).toBeNull();
    expect(parseCount({})).toBeNull();
    expect(parseCount([])).toBeNull();
  });

  it("truncates a float number to an integer", () => {
    expect(parseCount(10.9)).toBe(10);
  });
});

describe("parseDuration", () => {
  it("allows a fractional value (Apify's videoMeta.duration)", () => {
    expect(parseDuration(17.902)).toBe(17.902);
  });

  it("allows a plain integer (Bright Data's video_duration)", () => {
    expect(parseDuration(5)).toBe(5);
  });

  it("parses a numeric string", () => {
    expect(parseDuration("21.035")).toBeCloseTo(21.035);
  });

  it("returns null for missing/negative/invalid values", () => {
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(-5)).toBeNull();
    expect(parseDuration("not a number")).toBeNull();
    expect(parseDuration(NaN)).toBeNull();
  });

  it("allows zero", () => {
    expect(parseDuration(0)).toBe(0);
  });
});
