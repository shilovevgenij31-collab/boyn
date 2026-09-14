import { describe, expect, it } from "vitest";
import { computeDelta } from "@/core/report/comparison.ts";

describe("computeDelta", () => {
  it("computes a simple delta", () => {
    expect(computeDelta(10, 6)).toEqual({ current: 10, previous: 6, delta: 4 });
  });

  it("no previous report -> delta is null, never a fabricated 0", () => {
    expect(computeDelta(10, null)).toEqual({ current: 10, previous: null, delta: null });
  });

  it("handles a negative delta (decline)", () => {
    expect(computeDelta(3, 10)).toEqual({ current: 3, previous: 10, delta: -7 });
  });

  it("previous of 0 is a real value, not treated as missing", () => {
    expect(computeDelta(5, 0)).toEqual({ current: 5, previous: 0, delta: 5 });
  });
});
