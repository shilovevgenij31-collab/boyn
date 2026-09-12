import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "@/lib/clock";

describe("FixedClock", () => {
  it("returns the same instant until told to move", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("advanceMs moves time forward by exactly the given amount", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    clock.advanceMs(90 * 60 * 1000); // +90 minutes
    expect(clock.now().toISOString()).toBe("2026-09-12T01:30:00.000Z");
  });

  it("set() jumps to an arbitrary instant", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    clock.set(new Date("2030-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("SystemClock", () => {
  it("tracks real time", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
