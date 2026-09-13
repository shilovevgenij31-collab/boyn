/**
 * Freshness component (Phase 6 brief §22, plan §16.3): smooth exponential
 * decay, not a hard cliff — a post at 23h59m and one at 24h01m should
 * score almost identically. Report-time hard windows (TODAY <=24h, STILL
 * HOT 24-72h) are a Phase 7 concern layered on top of this raw value.
 */
import { FRESHNESS_HALF_LIFE_HOURS } from "@/config/scoring.ts";

/** 0.5^(age/halfLife): half-life 18h means 2h -> 0.93, 12h -> 0.63,
 * 24h -> 0.40, 48h -> 0.16. A future-dated publishedAt (clock skew) is
 * clamped to age 0 (freshness 1), never > 1. */
export function computeFreshness(ageHours: number): number {
  const clampedAge = Math.max(0, ageHours);
  return Math.pow(0.5, clampedAge / FRESHNESS_HALF_LIFE_HOURS);
}

export function ageHoursSince(publishedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
}
