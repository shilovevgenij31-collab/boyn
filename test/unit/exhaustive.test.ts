import { describe, expect, it } from "vitest";
import { assertNever } from "@/lib/exhaustive";

type Signal = "GO" | "STOP";

function describeSignal(signal: Signal): string {
  switch (signal) {
    case "GO":
      return "go";
    case "STOP":
      return "stop";
    default:
      return assertNever(signal, "describeSignal");
  }
}

describe("assertNever", () => {
  it("is unreachable for valid, handled variants", () => {
    expect(describeSignal("GO")).toBe("go");
    expect(describeSignal("STOP")).toBe("stop");
  });

  it("throws a descriptive error if reached at runtime (e.g. bad external input)", () => {
    // Cast simulates a value that bypassed the type system (e.g. from JSON).
    const bogus = "SIDEWAYS" as unknown as never;
    expect(() => assertNever(bogus, "describeSignal")).toThrow(/describeSignal/);
    expect(() => assertNever(bogus, "describeSignal")).toThrow(/SIDEWAYS/);
  });
});
