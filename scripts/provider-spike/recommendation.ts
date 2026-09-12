/**
 * Turns measured SpikeResults into the per-platform routing recommendation,
 * decision gate verdict, and product-fit conclusion the Phase 1 spike is
 * required to produce (see docs/IMPLEMENTATION_PLAN.md §28 Phase 1 /
 * PROVIDER_SPIKE instructions). Deterministic and data-driven — computed
 * from the actual measurements, not asserted by hand, so it stays accurate
 * across re-runs.
 */
import type { CombinationResult, PlatformName, ProviderName } from "./types.ts";
import type { FreshnessStats } from "./freshness.ts";

export type FreshnessRating = "GOOD" | "PARTIAL" | "POOR" | "UNKNOWN";
export type RouteDecision = ProviderName | "neither" | "INCONCLUSIVE";
export type GateResult = "PASSED" | "FAILED" | "BLOCKED";
export type ProductFitAnswer = "YES" | "PARTIALLY" | "NO" | "UNKNOWN";

/**
 * Thresholds on %<24h, chosen to reflect the plan's qualitative bar
 * ("meaningful <24h representation... not dominated by week-old/month-old
 * top posts"). GOOD requires a clear majority of the sample to be same-day;
 * PARTIAL requires at least a non-trivial minority; below that, the source
 * is effectively a historical/"top posts" feed for our purposes.
 */
const GOOD_PCT_LT_24H = 40;
const PARTIAL_PCT_LT_24H = 15;

export function rateFreshness(freshness: FreshnessStats | null): FreshnessRating {
  if (!freshness || freshness.withTimestamp === 0 || freshness.pctLt24h === null) return "UNKNOWN";
  if (freshness.pctLt24h >= GOOD_PCT_LT_24H) return "GOOD";
  if (freshness.pctLt24h >= PARTIAL_PCT_LT_24H) return "PARTIAL";
  return "POOR";
}

function ratingRank(rating: FreshnessRating): number {
  return { GOOD: 3, PARTIAL: 2, POOR: 1, UNKNOWN: 0 }[rating];
}

export interface PlatformRecommendation {
  platform: PlatformName;
  primaryDiscovery: RouteDecision;
  primaryDiscoveryReason: string;
  fallback: RouteDecision;
  fallbackReason: string;
  refresh: RouteDecision;
  refreshReason: string;
  gate: GateResult;
  gateReason: string;
  productFit: ProductFitAnswer;
  productFitReason: string;
}

function combinationSummary(c: CombinationResult): string {
  if (c.outcome === "TESTED") {
    const f = c.freshness;
    return `${c.provider}: TESTED, %<24h=${f?.pctLt24h ?? "—"}, median age=${f?.medianAgeHours ?? "—"}h (${rateFreshness(f)})`;
  }
  if (c.outcome === "BLOCKED") return `${c.provider}: BLOCKED (${c.blockedReason})`;
  return `${c.provider}: ERROR (${c.errorMessage})`;
}

export function buildPlatformRecommendation(
  platform: PlatformName,
  combos: CombinationResult[],
): PlatformRecommendation {
  const forPlatform = combos.filter((c) => c.platform === platform);
  const tested = forPlatform.filter((c) => c.outcome === "TESTED");
  const summaries = forPlatform.map(combinationSummary).join("; ");

  if (tested.length === 0) {
    return {
      platform,
      primaryDiscovery: "INCONCLUSIVE",
      primaryDiscoveryReason: `no discovery path was actually tested (${summaries})`,
      fallback: "INCONCLUSIVE",
      fallbackReason: "no discovery path was actually tested",
      refresh: "INCONCLUSIVE",
      refreshReason: "no discovery path was actually tested",
      gate: "BLOCKED",
      gateReason: `every candidate path for ${platform} is BLOCKED or ERRORED, not evaluated on real data (${summaries})`,
      productFit: "UNKNOWN",
      productFitReason: "no real data was collected for this platform in this run",
    };
  }

  const rated = tested.map((c) => ({ combo: c, rating: rateFreshness(c.freshness) }));
  rated.sort((a, b) => ratingRank(b.rating) - ratingRank(a.rating));
  const best = rated[0]!;

  const untested = forPlatform.filter((c) => c.outcome !== "TESTED");
  const untestedNote =
    untested.length > 0 ? ` (untested paths: ${untested.map(combinationSummary).join("; ")})` : "";

  if (best.rating === "POOR") {
    return {
      platform,
      primaryDiscovery: "neither",
      primaryDiscoveryReason:
        `the only/best tested path (${best.combo.provider}) is dominated by stale content ` +
        `(%<24h=${best.combo.freshness?.pctLt24h ?? "—"}, median age ${best.combo.freshness?.medianAgeHours ?? "—"}h) — ` +
        `not usable for "taking off today" detection as currently configured${untestedNote}`,
      fallback: "INCONCLUSIVE",
      fallbackReason: "no tested path met the freshness bar to serve as a fallback either",
      refresh: tested.some((c) => c.refreshByUrl?.verdict === "SUPPORTED")
        ? tested.find((c) => c.refreshByUrl?.verdict === "SUPPORTED")!.provider
        : "INCONCLUSIVE",
      refreshReason: tested.some((c) => c.refreshByUrl?.verdict === "SUPPORTED")
        ? "refresh-by-URL works even though discovery freshness is poor — still useful for re-checking a post found some other way"
        : "not established in this run",
      gate: "FAILED",
      gateReason:
        `tested discovery path(s) for ${platform} predominantly return stale content ` +
        `(${summaries}) — smallest recommended adjustment: try a different sort/recency ` +
        "control, a different actor/dataset, or a keyword+date-filter search instead of hashtag mode",
      productFit: "NO",
      productFitReason: `measured %<24h=${best.combo.freshness?.pctLt24h ?? "—"} on the only/best tested path — cannot reliably surface same-day breakouts`,
    };
  }

  const primary = best.combo.provider;
  const second = rated[1];
  const fallback: RouteDecision =
    second && second.rating !== "POOR" ? second.combo.provider : untested.length > 0 ? "INCONCLUSIVE" : "neither";
  const fallbackReason =
    second && second.rating !== "POOR"
      ? `${second.combo.provider} was also tested with acceptable freshness (%<24h=${second.combo.freshness?.pctLt24h ?? "—"})`
      : untested.length > 0
        ? `the other candidate path was not testable this run${untestedNote}`
        : "no other tested path met the freshness bar";

  const primarySupportsRefresh = best.combo.refreshByUrl?.verdict === "SUPPORTED";
  const otherSupportsRefresh = tested.find((c) => c !== best.combo && c.refreshByUrl?.verdict === "SUPPORTED");
  const refresh: RouteDecision = primarySupportsRefresh
    ? primary
    : otherSupportsRefresh
      ? otherSupportsRefresh.provider
      : "neither";
  const refreshReason = primarySupportsRefresh
    ? "refresh-by-URL confirmed working on the primary discovery provider"
    : otherSupportsRefresh
      ? "primary provider doesn't support refresh-by-URL, but the other tested provider does"
      : `refresh-by-URL not supported by any tested path for ${platform} in this run: ${tested.map((c) => `${c.provider}=${c.refreshByUrl?.verdict ?? "NOT_TESTED"}`).join(", ")}`;

  return {
    platform,
    primaryDiscovery: primary,
    primaryDiscoveryReason: `best measured freshness (%<24h=${best.combo.freshness?.pctLt24h ?? "—"}, median age ${best.combo.freshness?.medianAgeHours ?? "—"}h, rating ${best.rating})${untestedNote}`,
    fallback,
    fallbackReason,
    refresh,
    refreshReason,
    gate: "PASSED",
    gateReason: `at least one tested path (${primary}) shows meaningful same-day representation (%<24h=${best.combo.freshness?.pctLt24h ?? "—"})`,
    productFit: best.rating === "GOOD" ? "YES" : "PARTIALLY",
    productFitReason: `measured %<24h=${best.combo.freshness?.pctLt24h ?? "—"} on ${primary} (rating ${best.rating})`,
  };
}

export function buildAllRecommendations(combos: CombinationResult[]): PlatformRecommendation[] {
  return [buildPlatformRecommendation("tiktok", combos), buildPlatformRecommendation("instagram", combos)];
}
