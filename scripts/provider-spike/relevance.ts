/**
 * Query relevance measurement for Phase 1B (search-mode discovery): a fresh
 * result is useless if it isn't actually about the query. Checks each
 * record's caption and hashtags for a case-insensitive substring/membership
 * match against any query term. Pure, deterministic.
 */

export interface RelevanceResult {
  total: number;
  matched: number;
  pct: number;
  mismatchExamples: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/^#/, "");
}

/**
 * @param captionByRecord one caption string (or null) per record, same order as records
 * @param hashtagsByRecord one hashtags array (or null) per record, same order as records
 */
export function computeRelevance(
  captionByRecord: readonly (string | null)[],
  hashtagsByRecord: readonly (string[] | null)[],
  queryTerms: readonly string[],
  maxExamples = 5,
): RelevanceResult {
  const terms = queryTerms.map(normalize).filter((t) => t.length > 0);
  const total = captionByRecord.length;
  let matched = 0;
  const mismatchExamples: string[] = [];

  for (let i = 0; i < total; i++) {
    const caption = captionByRecord[i];
    const hashtags = hashtagsByRecord[i];
    const captionLower = caption ? caption.toLowerCase() : "";
    const tagSet = new Set((hashtags ?? []).map(normalize));

    const isMatch = terms.some((term) => captionLower.includes(term) || tagSet.has(term));
    if (isMatch) {
      matched++;
    } else if (mismatchExamples.length < maxExamples) {
      mismatchExamples.push((caption ?? "(no caption)").slice(0, 120));
    }
  }

  return {
    total,
    matched,
    pct: total === 0 ? 0 : Math.round((matched / total) * 1000) / 10,
    mismatchExamples,
  };
}
