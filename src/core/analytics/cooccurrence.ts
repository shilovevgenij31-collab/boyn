/**
 * Hashtag co-occurrence pair generation (Phase 6 brief §34-35, plan §17's
 * "clusters" groundwork). Pure: given one post's (already-deduplicated)
 * hashtag names, produces the unordered pairs to aggregate into
 * `hashtag_cooccurrence_daily`, with canonical `tagA < tagB` ordering so
 * the same pair is never stored both ways.
 */
import { COOCCURRENCE_CONFIG } from "@/config/scoring.ts";

export interface CooccurrencePair {
  tagA: string;
  tagB: string;
}

/**
 * `genericNames`/`blockedNames` are excluded from pair generation
 * (brief §34: configurable exclusion) but the caller is responsible for
 * still recording the plain post-hashtag association elsewhere — this
 * function only ever produces co-occurrence intelligence pairs.
 * `maxTagsPerPost` bounds the combinatorial blowup from a pathological
 * many-tag post (brief §49): tags beyond the cap are dropped, not
 * silently included.
 */
export function generateCooccurrencePairs(
  hashtagNames: string[],
  excludedNames: ReadonlySet<string>,
  maxTagsPerPost: number = COOCCURRENCE_CONFIG.maxTagsPerPost,
): CooccurrencePair[] {
  const meaningful = [...new Set(hashtagNames)].filter((name) => !excludedNames.has(name)).slice(0, maxTagsPerPost);

  const pairs: CooccurrencePair[] = [];
  for (let i = 0; i < meaningful.length; i++) {
    for (let j = i + 1; j < meaningful.length; j++) {
      const a = meaningful[i]!;
      const b = meaningful[j]!;
      pairs.push(a < b ? { tagA: a, tagB: b } : { tagA: b, tagB: a });
    }
  }
  return pairs;
}
