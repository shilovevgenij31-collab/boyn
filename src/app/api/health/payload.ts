import type { Clock } from "@/lib/clock";
import { systemClock } from "@/lib/clock";

export interface HealthPayload {
  ok: true;
  service: string;
  version: string;
  uptimeMs: number;
  timestamp: string;
}

// Real wall-clock process start, independent of any injected Clock: uptime
// is always measured against actual elapsed time, even when `clock` (used
// only for `timestamp`) is a FixedClock in a test.
const processStartedAtMs = Date.now();

/**
 * Pure payload builder, separated from the route handler so it can be unit
 * tested directly (see test/unit/health-payload.test.ts) without going
 * through Next.js request/response machinery.
 */
export function buildHealthPayload(clock: Clock = systemClock): HealthPayload {
  return {
    ok: true,
    service: "trend-radar",
    version: process.env.npm_package_version ?? "0.0.0",
    uptimeMs: Date.now() - processStartedAtMs,
    timestamp: clock.now().toISOString(),
  };
}
