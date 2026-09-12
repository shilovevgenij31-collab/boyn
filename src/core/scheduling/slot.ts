/**
 * Deterministic scheduling-slot boundaries (Phase 5 brief §6-7). Given the
 * same clock time + hour list, always produces the same slot start — used
 * to build collection_runs.slot_key, whose UNIQUE constraint is what makes
 * planning idempotent (repeated ticks for the same slot never create a
 * second logical run).
 *
 * All arithmetic is UTC-only (Date.UTC / getUTC*), so server/local timezone
 * never affects scheduling (Phase 5 brief §57).
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { Market } from "@/core/domain/market.ts";

export type SlotKind = "discovery" | "refresh";

/** The most recent slot boundary at or before `now`, given a sorted-or-not
 * list of UTC hours (e.g. [5, 13, 21]). Handles day rollover: if `now` is
 * before the first configured hour of its own UTC day, the boundary is the
 * last configured hour of the PREVIOUS UTC day (Date.UTC normalizes a
 * negative day-of-month across month/year boundaries on its own). */
export function computeSlotStart(now: Date, hoursUtc: readonly number[]): Date {
  if (hoursUtc.length === 0) {
    throw new RangeError("computeSlotStart: hoursUtc must not be empty");
  }
  const sorted = [...hoursUtc].sort((a, b) => a - b);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  let candidate: Date | null = null;
  for (const hour of sorted) {
    const slot = new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
    if (slot.getTime() <= now.getTime()) {
      candidate = slot;
    }
  }
  if (candidate) return candidate;

  const lastHourYesterday = sorted[sorted.length - 1]!;
  return new Date(Date.UTC(year, month, day - 1, lastHourYesterday, 0, 0, 0));
}

/** The next slot boundary strictly after `now` — used to report/log when
 * the next discovery/refresh run is due, not for planning itself. */
export function computeNextSlotStart(now: Date, hoursUtc: readonly number[]): Date {
  const current = computeSlotStart(now, hoursUtc);
  const sorted = [...hoursUtc].sort((a, b) => a - b);
  const currentHour = current.getUTCHours();
  const idx = sorted.indexOf(currentHour);
  const nextHour = sorted[(idx + 1) % sorted.length]!;
  if (idx + 1 < sorted.length) {
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), nextHour));
  }
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, nextHour));
}

/** Deterministic slot_key: same (kind, platform, market, slotStart) always
 * produces the same string, which is what collection_runs.slot_key's
 * UNIQUE constraint relies on for idempotent planning. */
export function buildSlotKey(kind: SlotKind, platform: Platform, market: Market, slotStart: Date): string {
  return `${kind}:${platform}:${market}:${slotStart.toISOString()}`;
}
