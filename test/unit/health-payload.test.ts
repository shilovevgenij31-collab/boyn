import { describe, expect, it } from "vitest";
import { FixedClock } from "@/lib/clock";
import { buildHealthPayload } from "@/app/api/health/payload";

describe("buildHealthPayload", () => {
  it("returns a well-formed, always-ok health payload", () => {
    const clock = new FixedClock(new Date("2026-09-12T12:00:00.000Z"));
    const payload = buildHealthPayload(clock);
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("trend-radar");
    expect(payload.timestamp).toBe("2026-09-12T12:00:00.000Z");
    expect(typeof payload.uptimeMs).toBe("number");
    expect(payload.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
