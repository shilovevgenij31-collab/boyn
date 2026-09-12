/**
 * One deterministic internal representation for a discovery query term,
 * so callers never have to worry about whether they wrote "cosplay" or
 * "#Cosplay" — both normalize to the same bare, lowercase form. Provider
 * adapters (not this module) decide whether their specific API wants the
 * "#" re-added (Bright Data does; Apify's `searchQueries`/`hashtags`
 * fields want it bare) — this stays provider-agnostic (Phase 4 brief §5).
 *
 * Deliberately reuses the same character class as hashtag normalization
 * (core/normalize/hashtags.ts) since a discovery query IS a hashtag/topic
 * term in this product — but kept as its own function rather than an
 * alias, since "query" and "hashtag" are different domain concepts that
 * happen to share a normalization rule today.
 */
const VALID_QUERY_PATTERN = /^[\p{L}\p{N}_]+$/u;
const MAX_QUERY_LENGTH = 100;

/** Strips a leading "#", Unicode-normalizes (NFKC), lowercases, and
 * trims. Returns null for anything empty, oversized, or containing
 * characters outside letters/numbers/underscore after stripping. */
export function normalizeQueryTerm(raw: string): string | null {
  let term = raw.trim();
  if (term.startsWith("#")) term = term.slice(1);
  term = term.normalize("NFKC").trim().toLowerCase();
  if (term.length === 0 || term.length > MAX_QUERY_LENGTH) return null;
  if (!VALID_QUERY_PATTERN.test(term)) return null;
  return term;
}

/** Normalizes a list of raw query terms, dropping invalid ones and
 * deduplicating (first-seen order preserved) — the same list handed to
 * two providers in one discovery run must resolve to identical queries. */
export function normalizeQueryTerms(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of raw) {
    const normalized = normalizeQueryTerm(term);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
