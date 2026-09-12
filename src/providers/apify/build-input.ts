/**
 * Apify actor input builders. Every shape here is a VERIFIED-working
 * production path from Phase 1/1B (docs/PROVIDER_SPIKE.md) — not
 * reconstructed from documentation. Takes already-normalized query terms
 * (core/normalize/query.ts) and decides, per actor, how to format them.
 */

/**
 * TikTok SEARCH mode — the ONLY verified-fresh TikTok discovery path
 * (median age 2.5h, 100% <24h in Phase 1B). Do NOT regress to
 * `hashtags` + `profileSorting` — that mode was measured and rejected
 * (median age 534.3h/~22 days, 3.3% <24h).
 */
export function buildApifyTikTokDiscoveryInput(
  queries: string[],
  resultsPerPage: number,
): Record<string, unknown> {
  return {
    searchQueries: queries,
    searchSection: "/video",
    videoSearchSorting: "LATEST",
    videoSearchDateFilter: "PAST_24_HOURS",
    resultsPerPage,
  };
}

/** Direct-video-URL refresh — verified `postURLs` field (Phase 1). */
export function buildApifyTikTokRefreshInput(urls: string[]): Record<string, unknown> {
  return { postURLs: urls };
}

/** Instagram hashtag discovery — verified `hashtags`/`resultsType`/
 * `resultsLimit` fields (Phase 1). No date/recency filter exists on this
 * actor (confirmed absent); no URL-input field either (refresh is
 * unsupported for Instagram — see provider.ts capabilities()). */
export function buildApifyInstagramDiscoveryInput(
  hashtags: string[],
  resultsLimit: number,
): Record<string, unknown> {
  return {
    hashtags,
    resultsType: "reels",
    resultsLimit,
  };
}
