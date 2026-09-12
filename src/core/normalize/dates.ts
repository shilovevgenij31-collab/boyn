/**
 * Provider publication-timestamp parsing. Real fixture evidence:
 *   - Apify TikTok: `createTimeISO` (ISO 8601 string, preferred) and
 *     `createTime` (unix seconds, as a JSON number).
 *   - Bright Data TikTok: `create_time` as an ISO 8601 string.
 *   - Apify Instagram: `timestamp` as an ISO 8601 string.
 * No provider was observed sending unix milliseconds for a publish date,
 * but the heuristic below (>1e12 => ms) is the same one already proven out
 * in scripts/provider-spike/extract.ts against this data, kept for safety
 * without inventing a new untested code path.
 *
 * Returns null (never a fabricated/clamped date) for anything unparseable
 * — a bad publish date alone must not fail normalization of an otherwise
 * usable post (see core/domain/social-post.ts).
 */
export function parseProviderDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const ms = Math.abs(value) > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) {
      return parseProviderDate(Number(trimmed));
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}
