import { describe, expect, it } from "vitest";
import { buildSlotKey, computeNextSlotStart, computeSlotStart } from "@/core/scheduling/slot.ts";

const HOURS = [5, 13, 21] as const;

describe("computeSlotStart", () => {
  it("exact boundary: now === a slot hour returns that same instant", () => {
    const now = new Date("2026-09-12T13:00:00.000Z");
    expect(computeSlotStart(now, HOURS)).toEqual(new Date("2026-09-12T13:00:00.000Z"));
  });

  it("one millisecond before a boundary returns the PREVIOUS slot", () => {
    const now = new Date("2026-09-12T12:59:59.999Z");
    expect(computeSlotStart(now, HOURS)).toEqual(new Date("2026-09-12T05:00:00.000Z"));
  });

  it("one millisecond after a boundary returns that same boundary", () => {
    const now = new Date("2026-09-12T13:00:00.001Z");
    expect(computeSlotStart(now, HOURS)).toEqual(new Date("2026-09-12T13:00:00.000Z"));
  });

  it("day rollover: before the first slot of the day returns the last slot of the PREVIOUS day", () => {
    const now = new Date("2026-09-12T02:00:00.000Z");
    expect(computeSlotStart(now, HOURS)).toEqual(new Date("2026-09-11T21:00:00.000Z"));
  });

  it("day rollover across a month boundary", () => {
    const now = new Date("2026-10-01T00:30:00.000Z");
    expect(computeSlotStart(now, HOURS)).toEqual(new Date("2026-09-30T21:00:00.000Z"));
  });

  it("is independent of hour list ordering", () => {
    const now = new Date("2026-09-12T14:00:00.000Z");
    expect(computeSlotStart(now, [21, 5, 13])).toEqual(computeSlotStart(now, HOURS));
  });

  it("throws on an empty hour list", () => {
    expect(() => computeSlotStart(new Date(), [])).toThrow(RangeError);
  });
});

describe("computeNextSlotStart", () => {
  it("returns the next boundary within the same day", () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    expect(computeNextSlotStart(now, HOURS)).toEqual(new Date("2026-09-12T13:00:00.000Z"));
  });

  it("wraps to the first slot of the NEXT day after the last slot", () => {
    const now = new Date("2026-09-12T22:00:00.000Z");
    expect(computeNextSlotStart(now, HOURS)).toEqual(new Date("2026-09-13T05:00:00.000Z"));
  });
});

describe("buildSlotKey", () => {
  it("is deterministic for the same inputs", () => {
    const slotStart = new Date("2026-09-12T13:00:00.000Z");
    expect(buildSlotKey("discovery", "tiktok", "global", slotStart)).toBe(
      buildSlotKey("discovery", "tiktok", "global", slotStart),
    );
  });

  it("differs across kind/platform/market/slotStart", () => {
    const slotStart = new Date("2026-09-12T13:00:00.000Z");
    const base = buildSlotKey("discovery", "tiktok", "global", slotStart);
    expect(buildSlotKey("refresh", "tiktok", "global", slotStart)).not.toBe(base);
    expect(buildSlotKey("discovery", "instagram", "global", slotStart)).not.toBe(base);
    expect(buildSlotKey("discovery", "tiktok", "US", slotStart)).not.toBe(base);
    expect(buildSlotKey("discovery", "tiktok", "global", new Date("2026-09-12T21:00:00.000Z"))).not.toBe(base);
  });
});
