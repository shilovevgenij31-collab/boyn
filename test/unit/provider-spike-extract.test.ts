import { describe, expect, it } from "vitest";
import { firstPresent, getPath, parseTimestamp } from "../../scripts/provider-spike/extract.ts";

describe("getPath", () => {
  it("resolves a dotted path", () => {
    expect(getPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined for a missing path", () => {
    expect(getPath({ a: {} }, "a.b.c")).toBeUndefined();
    expect(getPath({}, "a")).toBeUndefined();
  });

  it("does not throw when traversing through a non-object", () => {
    expect(getPath({ a: 5 }, "a.b")).toBeUndefined();
  });
});

describe("firstPresent", () => {
  it("returns the first candidate field that is actually present", () => {
    const record = { playCount: 5000 };
    expect(firstPresent(record, ["views", "play_count", "playCount"])).toEqual({
      field: "playCount",
      value: 5000,
    });
  });

  it("returns field: null when none of the candidates are present", () => {
    const record = { caption: "hi" };
    expect(firstPresent(record, ["views", "playCount"])).toEqual({ field: null, value: undefined });
  });

  it("skips a candidate with null/empty value in favor of a later present one", () => {
    const record = { views: null, play_count: 100 };
    expect(firstPresent(record, ["views", "play_count"])).toEqual({ field: "play_count", value: 100 });
  });
});

describe("parseTimestamp", () => {
  it("parses an ISO 8601 string", () => {
    const d = parseTimestamp("2026-09-12T10:00:00.000Z");
    expect(d?.toISOString()).toBe("2026-09-12T10:00:00.000Z");
  });

  it("parses unix seconds (10-digit number)", () => {
    const d = parseTimestamp(1757671200); // a 10-digit unix-seconds value
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(1757671200 * 1000);
  });

  it("parses unix milliseconds (13-digit number)", () => {
    const ms = 1757671200000;
    const d = parseTimestamp(ms);
    expect(d!.getTime()).toBe(ms);
  });

  it("parses a numeric string the same way as a number", () => {
    const d = parseTimestamp("1757671200");
    expect(d!.getTime()).toBe(1757671200 * 1000);
  });

  it("returns null for garbage input rather than a fabricated date", () => {
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp({})).toBeNull();
  });
});
