/**
 * Analytics orchestration (Phase 6 brief §3, §58): turns the durable
 * post/snapshot/hashtag history Phase 5 collects into scores, trend
 * states, hashtag momentum, co-occurrence, categories, and lifecycle
 * transitions. Framework-independent (db/clock/market passed in) and
 * rerunnable — every persistence step here is a full SET/upsert on
 * freshly-recomputed values, never an increment, so running this twice
 * against the same data produces the same result (brief §4).
 *
 * Deliberate scope trims (documented, not silent):
 *   - Hashtag category co-occurrence inference (plan §18 step 3) is not
 *     implemented — SEED + KEYWORD evidence only. Adding it needs a
 *     dedicated aggregate query this phase didn't have time to add
 *     without shortcuts; SEED/KEYWORD alone already gives correct
 *     multi-label output for every real fixture.
 *   - Post categories skip "discovery query category" evidence (plan §18
 *     step 4's QUERY source) — TAG + KEYWORD evidence only. Wiring which
 *     hashtag's query discovered a post requires joining
 *     post_discoveries, deferred for the same reason.
 *   - Tier-cap eviction (brief §40) is implemented and unit-tested in
 *     core/lifecycle/hashtag-lifecycle.ts (decideTierCapEviction), but
 *     this orchestrator only ever applies the conservative half: a full
 *     tier holds new candidates rather than automatically evicting an
 *     existing member. Automatic eviction of an already-tracked tag felt
 *     like the wrong default to ship without a real production signal to
 *     validate it against.
 */
import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import type { Deadline } from "@/lib/deadline.ts";
import type { Market } from "@/core/domain/market.ts";
import type { Platform } from "@/core/domain/platform.ts";
import { PLATFORMS } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";

import { computeVelocity, type VelocitySnapshot } from "@/core/analytics/velocity.ts";
import { computeAcceleration } from "@/core/analytics/acceleration.ts";
import { ageHoursSince } from "@/core/analytics/freshness.ts";
import { computeEngagementRatios } from "@/core/analytics/engagement.ts";
import { classifyPostTier } from "@/core/analytics/qualification.ts";
import { assembleScore, type PlatformBaselines } from "@/core/analytics/scoring.ts";
import { computeRobustBaseline, median, type RobustBaseline } from "@/core/analytics/baselines.ts";
import { applyTrendStateHysteresis, deriveHashtagTrendState, derivePostTrendState } from "@/core/analytics/trend-state.ts";
import { computeHashtagGrowth, computeHashtagMomentum, computePostHashtagMomentum } from "@/core/analytics/hashtag-momentum.ts";
import { generateCooccurrencePairs } from "@/core/analytics/cooccurrence.ts";
import { classifyHashtagByKeyword, classifyHashtagBySeed, mergeHashtagCategoryEvidence } from "@/core/categories/classify-hashtag.ts";
import { classifyPost } from "@/core/categories/classify-post.ts";
import { evaluateHashtagLifecycle, type HashtagLifecycleState, type LifecycleEvidence } from "@/core/lifecycle/hashtag-lifecycle.ts";

import {
  ANALYTICS_WINDOWS_HOURS,
  BASELINE_CONFIG,
  DEFAULT_BASELINES,
  POST_TREND_STATE_CONFIG,
  REFRESH_PRIORITY_CONFIG,
  RISING_SCORE_WEIGHTS,
  SCORING_VERSION,
  TREND_SCORE_WEIGHTS,
  type BaselineMetric,
} from "@/config/scoring.ts";
import { CANDIDATE_GENERATION, PASSIVE_REVIVAL, TIER_CAPS } from "@/config/lifecycle.ts";

import {
  getHashtagsForPosts,
  getPostsEligibleForScoring,
  getPostsSeenToday,
  getSnapshotsForPosts,
  replacePostCategories,
  updatePostScore,
  type AnalyticsPostRow,
} from "@/db/repositories/analytics-posts.ts";
import { getScoringBaseline, upsertScoringBaseline } from "@/db/repositories/analytics-baselines.ts";
import {
  applyTierTransition,
  countTierEventsToday,
  getCandidateHashtags,
  getHashtagQualifiedStatsSince,
  getHashtagRolling24hStats,
  getHashtagTrailingHistory,
  getQualifiedPostsAnyPath,
  getRecentDailyTrendStates,
  getTrackedHashtagsForAnalytics,
  updateTrackedHashtagTrendState,
  upsertHashtagDailyStat,
} from "@/db/repositories/analytics-hashtags.ts";
import { upsertCooccurrence } from "@/db/repositories/analytics-cooccurrence.ts";
import { getHashtagCategoriesBulk, upsertHashtagCategory } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { recordErrorEvent } from "@/db/repositories/error-events.ts";

export interface RunAnalyticsParams {
  db: Database;
  clock: Clock;
  market: Market;
  /** Bounds per-tick work (brief §60) — hashtag-level loops check this and
   * stop early rather than run unbounded; already-completed post scoring
   * for this call is not rolled back. */
  deadline?: Deadline;
}

export interface AnalyticsStats {
  postsAnalyzed: number;
  postsScored: number;
  baselinesUpdated: number;
  hashtagsUpdated: number;
  cooccurrencesUpdated: number;
  tierPromotions: number;
  tierDemotions: number;
  refreshPlansUpdated: number;
}

function emptyStats(): AnalyticsStats {
  return { postsAnalyzed: 0, postsScored: 0, baselinesUpdated: 0, hashtagsUpdated: 0, cooccurrencesUpdated: 0, tierPromotions: 0, tierDemotions: 0, refreshPlansUpdated: 0 };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function isExpired(deadline?: Deadline): boolean {
  return deadline ? deadline.isExpired() : false;
}

export async function runAnalytics(params: RunAnalyticsParams): Promise<AnalyticsStats> {
  const stats = emptyStats();
  try {
    return await runAnalyticsUnsafe(params, stats);
  } catch (error) {
    // Analytics failure must never be mistaken for a collection failure
    // (brief §60) — record it and return whatever partial stats were
    // accumulated before the failure, rather than throwing into the tick.
    await recordErrorEvent(params.db, {
      at: params.clock.now(),
      scope: "jobs.run-analytics",
      severity: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      context: { market: params.market },
    });
    return stats;
  }
}

async function runAnalyticsUnsafe(params: RunAnalyticsParams, stats: AnalyticsStats): Promise<AnalyticsStats> {
  const { db, clock, market, deadline } = params;
  const now = clock.now();

  const eligiblePosts = await getPostsEligibleForScoring(db, market, now, ANALYTICS_WINDOWS_HOURS.baseline);
  stats.postsAnalyzed = eligiblePosts.length;
  // No early return on zero eligible posts: hashtag trend-state/lifecycle
  // evaluation below must still run even when a tag currently has no
  // recent posts at all — that is exactly the evidence a demotion needs
  // to see (brief §38's "3 scans with 0 viral" / probe-budget-exhausted
  // path). Every stage below is written to handle empty inputs safely.

  const postIds = eligiblePosts.map((p) => p.id);
  const snapshotsByPost = groupBy(await getSnapshotsForPosts(db, postIds), (r) => r.postId);
  const hashtagRowsForEligible = await getHashtagsForPosts(db, postIds);
  const hashtagsByPost = groupBy(hashtagRowsForEligible, (r) => r.postId);

  const trackedList = await getTrackedHashtagsForAnalytics(db, market);
  const momentumByName = new Map(trackedList.map((t) => [t.hashtagName, t.momentum !== null ? Number(t.momentum) : null]));

  interface Computed {
    post: AnalyticsPostRow;
    ageHours: number;
    vph: number | null;
    vphPrevious: number | null;
    kind: ReturnType<typeof computeVelocity>["kind"];
    confidence: ReturnType<typeof computeVelocity>["confidence"];
    acceleration: number | null;
  }

  const computed: Computed[] = eligiblePosts.map((post) => {
    const ageHours = post.publishedAt ? ageHoursSince(post.publishedAt, now) : 0;
    const snaps: VelocitySnapshot[] = (snapshotsByPost.get(post.id) ?? []).map((s) => ({ observedAt: s.observedAt, views: s.views }));
    const velocity = computeVelocity({ snapshots: snaps, publishedAt: post.publishedAt, now });
    const acceleration = computeAcceleration(velocity.vph, velocity.vphPrevious, velocity.confidence);
    return { post, ageHours, vph: velocity.vph, vphPrevious: velocity.vphPrevious, kind: velocity.kind, confidence: velocity.confidence, acceleration };
  });

  // ---- Baselines (§15-17, §48): one per (platform, metric), computed
  // once and reused for every post of that platform in this run. ----
  function pickBaseline(samples: number[], platform: Platform, metric: BaselineMetric, previous: RobustBaseline | null): RobustBaseline {
    if (samples.length >= BASELINE_CONFIG.minSampleSize) return computeRobustBaseline(samples);
    if (previous && previous.n >= BASELINE_CONFIG.minSampleSize) return previous;
    const fallback = DEFAULT_BASELINES[`${platform}:${metric}`];
    return { medianLog1p: fallback?.medianLog1p ?? 0, madLog1p: fallback?.madLog1p ?? 1, n: samples.length };
  }

  const baselinesByPlatform = new Map<Platform, PlatformBaselines>();
  for (const platform of PLATFORMS) {
    const cohortWindowStart = new Date(now.getTime() - BASELINE_CONFIG.windowDays * 24 * 3_600_000);
    const cohort = computed.filter(
      (c) => c.post.platform === platform && c.post.firstSeenAt.getTime() >= cohortWindowStart.getTime() && (c.post.views ?? 0) >= BASELINE_CONFIG.minViewsForCohort,
    );
    const viewsSamples = cohort.map((c) => c.post.views).filter((v): v is number => v !== null);
    const vphSamples = cohort.map((c) => c.vph).filter((v): v is number => v !== null);
    const ratios = cohort.map((c) => computeEngagementRatios({ views: c.post.views, likes: c.post.likes, comments: c.post.comments, shares: c.post.shares }));
    const likeSamples = ratios.map((r) => r.likeRatio).filter((v): v is number => v !== null);
    const commentSamples = ratios.map((r) => r.commentRatio).filter((v): v is number => v !== null);
    const shareSamples = ratios.map((r) => r.shareRatio).filter((v): v is number => v !== null);

    const metricsAndSamples: [BaselineMetric, number[]][] = [
      ["views", viewsSamples],
      ["vph", vphSamples],
      ["like_ratio", likeSamples],
      ["comment_ratio", commentSamples],
      ["share_ratio", shareSamples],
    ];

    const perMetric: Record<BaselineMetric, RobustBaseline> = {} as Record<BaselineMetric, RobustBaseline>;
    for (const [metric, samples] of metricsAndSamples) {
      const previous = await getScoringBaseline(db, platform, market, metric);
      const baseline = pickBaseline(samples, platform, metric, previous);
      perMetric[metric] = baseline;
      await upsertScoringBaseline(db, { platform, market, metric, computedAt: now, baseline });
      stats.baselinesUpdated += 1;
    }

    baselinesByPlatform.set(platform, {
      views: perMetric.views,
      vph: perMetric.vph,
      likeRatio: perMetric.like_ratio,
      commentRatio: perMetric.comment_ratio,
      shareRatio: perMetric.share_ratio,
    });
  }

  // ---- Hashtag categories (§41-44): classify every distinct hashtag
  // referenced this run, once each, from SEED + KEYWORD evidence. ----
  const distinctHashtags = new Map<number, string>();
  for (const row of hashtagRowsForEligible) distinctHashtags.set(row.hashtagId, row.name);
  for (const [hashtagId, name] of distinctHashtags) {
    const evidence = mergeHashtagCategoryEvidence(classifyHashtagBySeed(name), classifyHashtagByKeyword(name));
    for (const e of evidence) {
      await upsertHashtagCategory(db, { hashtagId, category: e.category, source: e.source, confidence: e.confidence });
    }
  }
  const hashtagCategoryRows = await getHashtagCategoriesBulk(db, [...distinctHashtags.keys()]);
  const categoriesByHashtag = groupBy(hashtagCategoryRows, (r) => r.hashtagId);

  // ---- Score + qualify + trend-state + categorize each post (§19-28, §41-43, §45-47). ----
  for (const c of computed) {
    const post = c.post;
    const tagsForPost = hashtagsByPost.get(post.id) ?? [];
    const meaningfulTags = tagsForPost.filter((t) => !t.isGeneric && !t.isBlocked);
    const hashtagMomentum = computePostHashtagMomentum(meaningfulTags.map((t) => momentumByName.get(t.name) ?? null));

    const baselines = baselinesByPlatform.get(post.platform)!;
    const scoringInput = {
      views: post.views,
      metrics: { views: post.views, likes: post.likes, comments: post.comments, shares: post.shares },
      ageHours: c.ageHours,
      vph: c.vph,
      vphKind: c.kind,
      vphConfidence: c.confidence,
      acceleration: c.acceleration,
      hashtagMomentum,
      baselines,
    };
    const trendResult = assembleScore(scoringInput, TREND_SCORE_WEIGHTS);
    const risingResult = assembleScore(scoringInput, RISING_SCORE_WEIGHTS);

    const qualification = classifyPostTier({
      views: post.views,
      publishedAt: post.publishedAt,
      contentType: post.contentType,
      availability: post.availability,
      ageHours: c.ageHours,
      vph: c.vph,
      vphConfidence: c.confidence,
      comments: post.comments,
      shares: post.shares,
    });

    const candidateTrendState = derivePostTrendState({ ageHours: c.ageHours, trendScore: trendResult.score, risingScore: risingResult.score, acceleration: c.acceleration, vph: c.vph });
    const previousState = post.trendState ? { state: post.trendState, since: post.trendStateSince ?? now } : null;
    const trendState = applyTrendStateHysteresis(previousState, candidateTrendState, now, POST_TREND_STATE_CONFIG.hysteresisHours);
    const trendStateSince = trendState === post.trendState ? post.trendStateSince : now;

    let nextRefreshAt = post.nextRefreshAt;
    if (post.platform === "tiktok") {
      if (trendState === "BREAKOUT" || trendState === "RISING") {
        const boosted = new Date(now.getTime() + REFRESH_PRIORITY_CONFIG.prioritizedDelayHours * 3_600_000);
        if (!nextRefreshAt || boosted.getTime() < nextRefreshAt.getTime()) {
          nextRefreshAt = boosted;
          stats.refreshPlansUpdated += 1;
        }
      } else if ((REFRESH_PRIORITY_CONFIG.deprioritizeStates as readonly string[]).includes(trendState) && nextRefreshAt !== null) {
        nextRefreshAt = null;
        stats.refreshPlansUpdated += 1;
      }
    }

    await updatePostScore(db, post.id, {
      vph: c.vph,
      vphKind: c.kind,
      velocityConfidence: c.confidence,
      trendScore: trendResult.score,
      risingScore: risingResult.score,
      scoreComponents: { trend: trendResult.components, rising: risingResult.components },
      scoredAt: now,
      scoringVersion: SCORING_VERSION,
      tier: qualification.tier,
      trendState,
      trendStateSince,
      nextRefreshAt,
    });
    stats.postsScored += 1;

    const hashtagCategoryEvidence: { category: Category; confidence: number }[] = [];
    for (const tag of tagsForPost) {
      for (const cat of categoriesByHashtag.get(tag.hashtagId) ?? []) {
        hashtagCategoryEvidence.push({ category: cat.category, confidence: Number(cat.confidence) });
      }
    }
    const postCategoryEvidence = classifyPost({ hashtagCategories: hashtagCategoryEvidence, caption: post.caption });
    await replacePostCategories(db, post.id, postCategoryEvidence.map((e) => ({ category: e.category, confidence: e.confidence, source: e.source })));

    if (isExpired(deadline)) return stats;
  }

  // ---- Daily stats + co-occurrence (§30, §34-35): today's UTC calendar day. ----
  const dayStart = startOfUtcDay(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);
  const dateStr = dayStart.toISOString().slice(0, 10);
  const genericNames = new Set(hashtagRowsForEligible.filter((r) => r.isGeneric).map((r) => r.name));

  interface DailyAgg {
    postsSeen: number;
    watchPosts: number;
    viralPosts: number;
    breakoutPosts: number;
    creators: Set<string>;
    viralViewsSum: number;
    vphList: number[];
  }
  const dailyAggByPlatformHashtag = new Map<string, DailyAgg>();

  for (const platform of PLATFORMS) {
    if (isExpired(deadline)) break;
    const todaysPosts = await getPostsSeenToday(db, platform, market, dayStart, dayEnd);
    if (todaysPosts.length === 0) continue;
    const todaysHashtagRows = await getHashtagsForPosts(db, todaysPosts.map((p) => p.id));
    const tagsByPostToday = groupBy(todaysHashtagRows, (r) => r.postId);

    interface PairAgg {
      a: number;
      b: number;
      posts: number;
      viralPosts: number;
      viewsSum: number;
    }
    const perPair = new Map<string, PairAgg>();

    for (const p of todaysPosts) {
      const creatorKey = p.creatorUsername ?? p.creatorExternalId ?? String(p.id);
      const tags = tagsByPostToday.get(p.id) ?? [];
      const isViral = p.tier === "VIRAL_QUALIFIED";
      const isBreakout = p.tier === "EARLY_BREAKOUT";
      const isWatch = p.tier === "WATCH";

      for (const tag of tags) {
        const key = `${platform}:${tag.hashtagId}`;
        let agg = dailyAggByPlatformHashtag.get(key);
        if (!agg) {
          agg = { postsSeen: 0, watchPosts: 0, viralPosts: 0, breakoutPosts: 0, creators: new Set(), viralViewsSum: 0, vphList: [] };
          dailyAggByPlatformHashtag.set(key, agg);
        }
        agg.postsSeen += 1;
        if (isWatch) agg.watchPosts += 1;
        if (isViral) agg.viralPosts += 1;
        if (isBreakout) agg.breakoutPosts += 1;
        agg.creators.add(creatorKey);
        if ((isViral || isBreakout) && p.views !== null) agg.viralViewsSum += p.views;
        if (p.vph !== null) agg.vphList.push(Number(p.vph));
      }

      const pairs = generateCooccurrencePairs(
        tags.map((t) => t.name),
        genericNames,
      );
      const nameToId = new Map(tags.map((t) => [t.name, t.hashtagId]));
      for (const pair of pairs) {
        const aId = nameToId.get(pair.tagA)!;
        const bId = nameToId.get(pair.tagB)!;
        const key = `${aId}:${bId}`;
        let pairAgg = perPair.get(key);
        if (!pairAgg) {
          pairAgg = { a: aId, b: bId, posts: 0, viralPosts: 0, viewsSum: 0 };
          perPair.set(key, pairAgg);
        }
        pairAgg.posts += 1;
        if (isViral || isBreakout) {
          pairAgg.viralPosts += 1;
          if (p.views !== null) pairAgg.viewsSum += p.views;
        }
      }
    }

    for (const pairAgg of perPair.values()) {
      await upsertCooccurrence(db, { date: dateStr, platform, market, tagAId: pairAgg.a, tagBId: pairAgg.b, posts: pairAgg.posts, viralPosts: pairAgg.viralPosts, viewsSum: pairAgg.viewsSum || null });
      stats.cooccurrencesUpdated += 1;
    }
  }

  // Untracked hashtags that appeared today still get a bare daily-stat
  // row (candidate generation needs posts_seen history to exist even
  // before a tag is tracked) — trend_state/momentum stay null; only
  // TRACKED tags have that concept meaningfully computed (below).
  const trackedKeys = new Set(trackedList.map((t) => `${t.platform}:${t.hashtagId}`));
  for (const [key, agg] of dailyAggByPlatformHashtag) {
    if (trackedKeys.has(key)) continue;
    const [platform, hashtagIdStr] = key.split(":") as [Platform, string];
    await upsertHashtagDailyStat(db, {
      date: dateStr,
      platform,
      market,
      hashtagId: Number(hashtagIdStr),
      postsSeen: agg.postsSeen,
      watchPosts: agg.watchPosts,
      viralPosts: agg.viralPosts,
      breakoutPosts: agg.breakoutPosts,
      distinctCreators: agg.creators.size,
      viralViewsSum: agg.viralViewsSum || null,
      medianVph: agg.vphList.length > 0 ? median(agg.vphList) : null,
      scans: agg.postsSeen,
      trendState: null,
      momentum: null,
    });
    stats.hashtagsUpdated += 1;
  }

  // ---- Tracked-hashtag trend state, momentum, and lifecycle (§31-33, §37-40). ----
  const tierSizeByKey = new Map<string, number>();
  for (const t of trackedList) {
    const key = `${t.platform}:${t.tier}`;
    tierSizeByKey.set(key, (tierSizeByKey.get(key) ?? 0) + 1);
  }

  for (const tracked of trackedList) {
    if (isExpired(deadline)) break;
    const platform = tracked.platform;

    const rolling = await getHashtagRolling24hStats(db, tracked.hashtagId, platform, market, now);
    const trailing = await getHashtagTrailingHistory(db, tracked.hashtagId, platform, market, dayStart);
    const g = computeHashtagGrowth(rolling.v24, trailing.b7);
    const candidateState = deriveHashtagTrendState({ v24: rolling.v24, c24: rolling.c24, w24: rolling.w24, b7: trailing.b7, g, historyDays: trailing.historyDays });
    const previousState = tracked.trendState ? { state: tracked.trendState, since: tracked.trendStateSince ?? now } : null;
    const trendState = applyTrendStateHysteresis(previousState, candidateState, now, POST_TREND_STATE_CONFIG.hysteresisHours);
    const trendStateSince = trendState === tracked.trendState ? (tracked.trendStateSince ?? now) : now;
    const momentum = computeHashtagMomentum(g, rolling.v24);

    const agg = dailyAggByPlatformHashtag.get(`${platform}:${tracked.hashtagId}`);
    await upsertHashtagDailyStat(db, {
      date: dateStr,
      platform,
      market,
      hashtagId: tracked.hashtagId,
      postsSeen: agg?.postsSeen ?? 0,
      watchPosts: agg?.watchPosts ?? 0,
      viralPosts: agg?.viralPosts ?? 0,
      breakoutPosts: agg?.breakoutPosts ?? 0,
      distinctCreators: agg?.creators.size ?? 0,
      viralViewsSum: agg?.viralViewsSum || null,
      medianVph: agg && agg.vphList.length > 0 ? median(agg.vphList) : null,
      scans: agg?.postsSeen ?? 0,
      trendState,
      momentum,
    });
    stats.hashtagsUpdated += 1;
    await updateTrackedHashtagTrendState(db, tracked.trackedHashtagId, { trendState, trendStateSince, momentum });

    const recentWeak = await getRecentDailyTrendStates(db, tracked.hashtagId, platform, market, 3);
    let consecutiveWeakTrendStateEvals = 0;
    for (const s of recentWeak) {
      if (s === "FALLING" || s === "DEAD") consecutiveWeakTrendStateEvals += 1;
      else break;
    }

    const sinceTierChange = tracked.tierChangedAt ?? new Date(0);
    const evidenceStats = await getHashtagQualifiedStatsSince(db, tracked.hashtagId, platform, market, sinceTierChange);
    const recentQualifiedPostsAnyPath = await getQualifiedPostsAnyPath(db, tracked.hashtagId, platform, market, now, PASSIVE_REVIVAL.windowHours);
    const daysInTier = tracked.tierChangedAt ? (now.getTime() - tracked.tierChangedAt.getTime()) / (24 * 3_600_000) : Number.POSITIVE_INFINITY;

    const lifecycleState: HashtagLifecycleState = { tier: tracked.tier, source: tracked.source, tierChangedAt: tracked.tierChangedAt, probesInTier: tracked.probesInTier, daysInTier };
    const evidence: LifecycleEvidence = {
      qualifiedPostsInTier: evidenceStats.qualified,
      distinctCreatorsInTier: evidenceStats.distinctCreators,
      trendState,
      consecutiveWeakTrendStateEvals,
      consecutiveEmptyScans: tracked.consecutiveEmptyScans,
      recentQualifiedPostsAnyPath,
    };
    const decision = evaluateHashtagLifecycle(lifecycleState, evidence, now);
    if (decision.action === "hold") continue;

    if (decision.action === "promote") {
      const cap = decision.toTier === "EXPLORATION" ? TIER_CAPS.exploration : decision.toTier === "ACTIVE" ? TIER_CAPS.active : null;
      const key = `${platform}:${decision.toTier}`;
      const currentSize = tierSizeByKey.get(key) ?? 0;
      if (cap !== null && currentSize >= cap) continue; // full — hold, no auto-eviction (see module doc comment)
      await applyTierTransition(db, { trackedHashtagId: tracked.trackedHashtagId, fromTier: tracked.tier, toTier: decision.toTier, reason: decision.reason, at: now });
      tierSizeByKey.set(key, currentSize + 1);
      tierSizeByKey.set(`${platform}:${tracked.tier}`, (tierSizeByKey.get(`${platform}:${tracked.tier}`) ?? 1) - 1);
      stats.tierPromotions += 1;
    } else {
      await applyTierTransition(db, { trackedHashtagId: tracked.trackedHashtagId, fromTier: tracked.tier, toTier: decision.toTier, reason: decision.reason, at: now });
      const fromKey = `${platform}:${tracked.tier}`;
      tierSizeByKey.set(fromKey, (tierSizeByKey.get(fromKey) ?? 1) - 1);
      tierSizeByKey.set(`${platform}:${decision.toTier}`, (tierSizeByKey.get(`${platform}:${decision.toTier}`) ?? 0) + 1);
      stats.tierDemotions += 1;
    }
  }

  // ---- Candidate generation (§11, §36): brand-new untracked tags -> EXPLORATION. ----
  for (const platform of PLATFORMS) {
    if (isExpired(deadline)) break;
    const explorationKey = `${platform}:EXPLORATION`;
    let explorationSize = tierSizeByKey.get(explorationKey) ?? 0;
    if (explorationSize >= TIER_CAPS.exploration) continue;

    const newToday = await countTierEventsToday(db, platform, market, "EXPLORATION", dayStart, dayEnd);
    let remainingQuota = TIER_CAPS.maxNewExplorationPerDay - newToday;
    if (remainingQuota <= 0) continue;

    const candidates = await getCandidateHashtags(db, platform, market, now, CANDIDATE_GENERATION.windowHours, CANDIDATE_GENERATION.minQualifiedPosts, CANDIDATE_GENERATION.minDistinctCreators);
    for (const candidate of candidates) {
      if (remainingQuota <= 0 || explorationSize >= TIER_CAPS.exploration) break;
      if (candidate.name.length < CANDIDATE_GENERATION.minHashtagLength) continue;

      const result = await ensureTrackedHashtag(db, { hashtagId: candidate.hashtagId, platform, market, tier: "EXPLORATION", source: "DISCOVERED" });
      if (!result.created) continue; // already tracked by the time we got here — not a new candidate
      await applyTierTransition(db, { trackedHashtagId: result.id, fromTier: null, toTier: "EXPLORATION", reason: "candidate_generation", at: now });
      stats.tierPromotions += 1;
      remainingQuota -= 1;
      explorationSize += 1;
    }
    tierSizeByKey.set(explorationKey, explorationSize);
  }

  return stats;
}
