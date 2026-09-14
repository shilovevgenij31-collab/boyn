/**
 * Rising Now selection (Phase 7 brief §17): top-N by RisingScore over
 * whatever eligible pool the caller passes in (build-daily-report.ts uses
 * the same 72h qualifying pool as Today/Still Hot) — RisingScore's own
 * freshness component already suppresses old posts, so no separate
 * hard age/views/vph gate is duplicated here (brief: "do not duplicate
 * incompatible magic numbers if Phase 6 has canonical thresholds").
 */
export interface RisingCandidate {
  postId: number;
  risingScore: number;
  vph: number;
  publishedAtMs: number;
}

function compareByRisingScore(a: RisingCandidate, b: RisingCandidate): number {
  if (b.risingScore !== a.risingScore) return b.risingScore - a.risingScore;
  if (b.vph !== a.vph) return b.vph - a.vph;
  if (b.publishedAtMs !== a.publishedAtMs) return b.publishedAtMs - a.publishedAtMs;
  return a.postId - b.postId;
}

export function selectRisingNow<T extends RisingCandidate>(candidates: T[], max: number): T[] {
  return [...candidates].sort(compareByRisingScore).slice(0, max);
}
