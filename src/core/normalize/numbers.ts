/**
 * Deterministic numeric normalization for provider engagement/count
 * fields. Real fixture evidence for every branch here:
 *   - Bright Data TikTok `share_count` is a numeric STRING ("9") while
 *     every sibling count field is a plain number — providers are not
 *     internally consistent about this.
 *   - Instagram `likesCount` uses `-1` as a "hidden by creator" sentinel.
 * Rule throughout: missing/invalid -> null, never 0. A count is never
 * negative in the output — a negative raw value (whatever sentinel it
 * represents) normalizes to null, not to 0 or to the negative number.
 */

/** Integer counts: views, likes, comments, shares, saves, followers. */
export function parseCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value < 0) return null; // e.g. Instagram's -1 "hidden" sentinel
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null; // rejects "-1", "1.5", "", "N/A", etc.
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** Durations (seconds): allows a fractional value (Apify's `videoMeta.duration`
 * is a float like 17.902), still rejects negative/garbage. */
export function parseDuration(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
