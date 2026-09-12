/**
 * Bright Data "Discover by keyword" input builder — the VERIFIED shape
 * from Phase 1/1B (docs/PROVIDER_SPIKE.md), not reconstructed from
 * documentation. `search_keyword` intentionally keeps a leading "#" —
 * that's what the verified working example uses; takes already-
 * normalized bare terms (core/normalize/query.ts) and re-adds it here,
 * so the "#" decision stays local to this one adapter.
 */
export interface BrightDataTikTokDiscoveryBody {
  input: { search_keyword: string; country: string }[];
  limit_per_input: number;
}

export function buildBrightDataTikTokDiscoveryInput(
  queries: string[],
  limitPerInput: number,
): BrightDataTikTokDiscoveryBody {
  return {
    input: queries.map((q) => ({ search_keyword: `#${q}`, country: "" })),
    limit_per_input: limitPerInput,
  };
}

export const BRIGHTDATA_DISCOVERY_QUERY = {
  notify: "false",
  type: "discover_new",
  discover_by: "keyword",
} as const;
