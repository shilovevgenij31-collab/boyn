/**
 * Engagement ratios (Phase 6 brief §13, plan §16.4): like/comment/share
 * counts normalized against views so accounts of any size are
 * comparable, each ratio z-scored against its OWN platform distribution
 * downstream (scoring.ts) rather than an arbitrary "a share is worth 5
 * likes" multiplier. A metric the provider never returns (Instagram
 * shares, IG's hidden -1 likes already normalized to null upstream) is
 * `null` here too, never coerced to 0 — it simply drops out of engagement
 * scoring's weighted combination (weighting.ts).
 */
export interface EngagementMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface EngagementRatios {
  likeRatio: number | null;
  commentRatio: number | null;
  shareRatio: number | null;
}

function ratio(count: number | null, views: number | null): number | null {
  if (count === null || views === null || views < 0) return null;
  return (count + 1) / (views + 1);
}

export function computeEngagementRatios(metrics: EngagementMetrics): EngagementRatios {
  return {
    likeRatio: ratio(metrics.likes, metrics.views),
    commentRatio: ratio(metrics.comments, metrics.views),
    shareRatio: ratio(metrics.shares, metrics.views),
  };
}
