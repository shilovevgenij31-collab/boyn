/**
 * Drizzle schema — the PostgreSQL source of truth for Trend Radar.
 *
 * Conventions (see docs/IMPLEMENTATION_PLAN.md §8 and Phase 3 instructions):
 *   - `bigint(..., { mode: "number" })` identity PKs and count/metric
 *     columns. JS numbers are exact up to 2^53-1 (~9.007e15) — far beyond
 *     any realistic social metric — so every application boundary that
 *     reads these columns gets a plain `number`, never a JS `bigint` or a
 *     string, and never needs special (de)serialization. Documented here
 *     once rather than at every call site.
 *   - `timestamp(..., { withTimezone: true, mode: "date" })` for instants
 *     (always UTC in, UTC out); plain `date()` only for true calendar
 *     dates (`report_date`, the `date` column on the two daily-rollup
 *     tables) — never an ISO string standing in for either.
 *   - `numeric(precision, scale)` for money (`cost_est_usd`), never
 *     float/real — Postgres NUMERIC and this driver return it as a
 *     string, which is the correct, precision-safe representation; it is
 *     intentionally NOT coerced to a JS number at this layer.
 *   - Provider metrics (views/likes/comments/shares/saves/followers/
 *     duration) are always nullable, never `DEFAULT 0` — missing != zero
 *     (CLAUDE.md rule 8, carried from Phase 2 normalization straight into
 *     the schema).
 *   - `market` (not `locale`) — see ADR-020. `'global'` is a real value.
 *   - Enums mirror Phase 2 domain types where one already exists
 *     (`platform`, `content_type`, `views_metric` match
 *     src/core/domain/{platform,content-type,views-metric}.ts exactly);
 *     other enums (tracking tier, job status, ...) are new here because
 *     Phase 3 is the first phase that needs them persisted.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

function id() {
  return bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
}

function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const platformEnum = pgEnum("platform", ["tiktok", "instagram"]);
export const contentTypeEnum = pgEnum("content_type", ["video", "reel", "image", "carousel", "unknown"]);
export const viewsMetricEnum = pgEnum("views_metric", [
  "tt_apify_play_count",
  "tt_brightdata_play_count",
  "ig_apify_video_play_count",
  "ig_apify_video_view_count",
]);
export const providerEnum = pgEnum("provider", ["apify", "brightdata"]);
export const categoryEnum = pgEnum("category", ["cosplay", "streaming", "gaming", "pc", "playstation"]);

export const postTierEnum = pgEnum("post_tier", ["VIRAL_QUALIFIED", "EARLY_BREAKOUT", "WATCH", "NOISE"]);
export const availabilityEnum = pgEnum("availability", ["ACTIVE", "DELETED", "PRIVATE", "UNKNOWN"]);
export const vphKindEnum = pgEnum("vph_kind", ["OBSERVED", "ESTIMATED"]);
export const velocityConfidenceEnum = pgEnum("velocity_confidence", ["HIGH", "MEDIUM", "LOW"]);
export const snapshotSourceEnum = pgEnum("snapshot_source", ["DISCOVERY", "REFRESH"]);
export const postCategorySourceEnum = pgEnum("post_category_source", ["TAG", "KEYWORD", "QUERY", "AI"]);

export const trackingTierEnum = pgEnum("tracking_tier", ["CORE", "ACTIVE", "EXPLORATION", "DORMANT"]);
export const hashtagSourceEnum = pgEnum("hashtag_source", ["SEED", "DISCOVERED", "MANUAL"]);
export const trendStateEnum = pgEnum("trend_state", [
  "BREAKOUT",
  "RISING",
  "ACTIVE",
  "STABLE",
  "FALLING",
  "DEAD",
  "NEW",
]);
export const hashtagCategorySourceEnum = pgEnum("hashtag_category_source", [
  "SEED",
  "KEYWORD",
  "COOCCURRENCE",
  "MANUAL",
  "AI",
]);

export const collectionRunKindEnum = pgEnum("collection_run_kind", ["DISCOVERY", "REFRESH", "MANUAL"]);
export const collectionRunStatusEnum = pgEnum("collection_run_status", [
  "PLANNED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "SKIPPED",
]);
export const jobTypeEnum = pgEnum("job_type", ["HASHTAG_DISCOVERY", "POST_REFRESH"]);
export const jobStatusEnum = pgEnum("job_status", [
  "PENDING",
  "SUBMITTED",
  "RUNNING",
  "READY",
  "INGESTED",
  "FAILED",
  "TIMED_OUT",
]);
export const reportStatusEnum = pgEnum("report_status", ["COMPLETE", "PARTIAL"]);
export const aiInsightStatusEnum = pgEnum("ai_insight_status", ["PENDING", "SUCCEEDED", "FAILED"]);
export const errorSeverityEnum = pgEnum("error_severity", ["INFO", "WARN", "ERROR", "FATAL"]);

// ---------------------------------------------------------------------------
// Content: posts, snapshots, hashtags, associations
// ---------------------------------------------------------------------------

export const posts = pgTable(
  "posts",
  {
    id: id(),
    platform: platformEnum("platform").notNull(),
    externalId: text("external_id").notNull(),
    market: text("market").notNull().default("global"),
    language: text("language"),

    canonicalUrl: text("canonical_url").notNull(),
    contentType: contentTypeEnum("content_type").notNull(),

    creatorUsername: text("creator_username"),
    creatorExternalId: text("creator_external_id"),
    creatorFollowers: bigint("creator_followers", { mode: "number" }),
    creatorVerified: boolean("creator_verified"),

    caption: text("caption"),

    musicId: text("music_id"),
    musicTitle: text("music_title"),
    musicAuthor: text("music_author"),

    publishedAt: instant("published_at"),
    durationSec: numeric("duration_sec", { precision: 10, scale: 3 }),

    // Latest known metrics (denormalized convenience — see post_snapshots
    // for the historical time series; §32 of the Phase 3 brief).
    views: bigint("views", { mode: "number" }),
    viewsMetric: viewsMetricEnum("views_metric"),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    saves: bigint("saves", { mode: "number" }),

    firstSeenAt: instant("first_seen_at").notNull(),
    lastSeenAt: instant("last_seen_at").notNull(),
    lastRefreshedAt: instant("last_refreshed_at"),

    tier: postTierEnum("tier"),
    availability: availabilityEnum("availability").notNull().default("ACTIVE"),

    // Phase 6 scoring — nullable persistence fields only, no logic here.
    vph: numeric("vph", { precision: 14, scale: 2 }),
    vphKind: vphKindEnum("vph_kind"),
    velocityConfidence: velocityConfidenceEnum("velocity_confidence"),
    trendScore: smallint("trend_score"),
    risingScore: smallint("rising_score"),
    // Post-level trend state (Phase 6) — deliberately the SAME enum type
    // trackedHashtags/hashtagDailyStats use, but a DIFFERENT concept: this
    // describes what a single post is doing right now (BREAKOUT/RISING/
    // ACTIVE/STABLE/FALLING/DEAD), never a tracking tier. trendStateSince
    // exists for hysteresis (avoid flapping between adjacent states).
    trendState: trendStateEnum("trend_state"),
    trendStateSince: instant("trend_state_since"),
    scoreComponents: jsonb("score_components").$type<Record<string, unknown>>(),
    scoredAt: instant("scored_at"),
    scoringVersion: integer("scoring_version"),
    nextRefreshAt: instant("next_refresh_at"),
    paidRefreshCount: smallint("paid_refresh_count").notNull().default(0),

    discoveredViaHashtagId: bigint("discovered_via_hashtag_id", { mode: "number" }).references(
      () => hashtags.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("posts_platform_external_id_key").on(t.platform, t.externalId),
    index("posts_platform_market_published_at_idx").on(t.platform, t.market, t.publishedAt),
    index("posts_next_refresh_at_idx").on(t.nextRefreshAt),
    index("posts_tier_published_at_idx").on(t.tier, t.publishedAt),
  ],
);

/**
 * Historical time series. A snapshot represents observed metrics at one
 * moment; `posts.*` metric columns are only the latest convenience copy.
 *
 * Dedup strategy (Phase 3 brief §8/§32/§39-H): the natural key would be
 * `(post_id, provider_job_id)`, but `provider_job_id` is nullable (a
 * snapshot can come from a context with no job row yet, e.g. a future
 * manual/test insert) and a single provider job can legitimately return
 * the same post more than once (e.g. it matched two queries in one
 * multi-keyword Bright Data job). A plain unique constraint on
 * `(post_id, provider_job_id)` would therefore either reject legitimate
 * repeats (job matched twice) or fail to dedup at all when the job id is
 * null. Instead: no DB-level uniqueness constraint here — the repository
 * layer decides idempotency (see repositories/posts.ts `insertPostSnapshot`,
 * which skips inserting a new row when the most recent snapshot for this
 * post is younger than a short window and reports identical metrics,
 * covering "re-ingesting the same observation" without a rigid, easy-to-
 * violate composite key).
 */
export const postSnapshots = pgTable(
  "post_snapshots",
  {
    id: id(),
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    observedAt: instant("observed_at").notNull(),

    views: bigint("views", { mode: "number" }),
    viewsMetric: viewsMetricEnum("views_metric"),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    saves: bigint("saves", { mode: "number" }),

    source: snapshotSourceEnum("source").notNull(),
    providerJobId: bigint("provider_job_id", { mode: "number" }).references(() => providerJobs.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("post_snapshots_post_id_observed_at_idx").on(t.postId, t.observedAt)],
);

export const hashtags = pgTable("hashtags", {
  id: id(),
  // Already normalized by core/normalize/hashtags.ts before it reaches the
  // repository layer — no leading "#", NFKC, lowercase. The DB does not
  // re-normalize; it trusts and enforces uniqueness on what it's given.
  name: text("name").notNull().unique(),
  isGeneric: boolean("is_generic").notNull().default(false),
  isBlocked: boolean("is_blocked").notNull().default(false),
  firstSeenAt: instant("first_seen_at").notNull(),
  lastSeenAt: instant("last_seen_at").notNull(),
});

export const postHashtags = pgTable(
  "post_hashtags",
  {
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    hashtagId: bigint("hashtag_id", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),
    position: smallint("position"),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.hashtagId] }),
    index("post_hashtags_hashtag_id_post_id_idx").on(t.hashtagId, t.postId),
  ],
);

/**
 * Which query found this post, from which job, at what rank. Multiple
 * rows per post are expected and useful (the same post found again by a
 * different tag/job is a real, separate discovery event) — the PK is the
 * job+post pair, not just the post, precisely so re-discovery accumulates
 * provenance instead of being silently deduplicated away.
 */
export const postDiscoveries = pgTable(
  "post_discoveries",
  {
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    providerJobId: bigint("provider_job_id", { mode: "number" })
      .notNull()
      .references(() => providerJobs.id, { onDelete: "cascade" }),
    hashtagId: bigint("hashtag_id", { mode: "number" }).references(() => hashtags.id, { onDelete: "set null" }),
    queryText: text("query_text"),
    rankInResults: smallint("rank_in_results"),
    observedAt: instant("observed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.providerJobId] }),
    index("post_discoveries_hashtag_id_idx").on(t.hashtagId),
  ],
);

export const postCategories = pgTable(
  "post_categories",
  {
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    category: categoryEnum("category").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    source: postCategorySourceEnum("source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.category] })],
);

// ---------------------------------------------------------------------------
// Hashtag tracking, taxonomy, and trend history
// ---------------------------------------------------------------------------

export const trackedHashtags = pgTable(
  "tracked_hashtags",
  {
    id: id(),
    hashtagId: bigint("hashtag_id", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    market: text("market").notNull().default("global"),

    tier: trackingTierEnum("tier").notNull(),
    source: hashtagSourceEnum("source").notNull(),
    priority: numeric("priority", { precision: 10, scale: 4 }).notNull().default("0"),

    trendState: trendStateEnum("trend_state").notNull().default("NEW"),
    trendStateSince: instant("trend_state_since"),
    momentum: numeric("momentum", { precision: 6, scale: 5 }),

    nextDueAt: instant("next_due_at"),
    lastScannedAt: instant("last_scanned_at"),
    scansTotal: integer("scans_total").notNull().default(0),
    probesInTier: integer("probes_in_tier").notNull().default(0),
    consecutiveEmptyScans: integer("consecutive_empty_scans").notNull().default(0),
    tierChangedAt: instant("tier_changed_at"),
  },
  (t) => [
    uniqueIndex("tracked_hashtags_hashtag_platform_market_key").on(t.hashtagId, t.platform, t.market),
    index("tracked_hashtags_platform_market_tier_next_due_idx").on(t.platform, t.market, t.tier, t.nextDueAt),
  ],
);

export const hashtagCategories = pgTable(
  "hashtag_categories",
  {
    hashtagId: bigint("hashtag_id", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),
    category: categoryEnum("category").notNull(),
    source: hashtagCategorySourceEnum("source").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.hashtagId, t.category] })],
);

export const hashtagDailyStats = pgTable(
  "hashtag_daily_stats",
  {
    date: date("date").notNull(),
    platform: platformEnum("platform").notNull(),
    market: text("market").notNull().default("global"),
    hashtagId: bigint("hashtag_id", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),

    postsSeen: integer("posts_seen").notNull().default(0),
    watchPosts: integer("watch_posts").notNull().default(0),
    viralPosts: integer("viral_posts").notNull().default(0),
    breakoutPosts: integer("breakout_posts").notNull().default(0),
    distinctCreators: integer("distinct_creators").notNull().default(0),

    viralViewsSum: bigint("viral_views_sum", { mode: "number" }),
    medianVph: numeric("median_vph", { precision: 14, scale: 2 }),
    scans: integer("scans").notNull().default(0),

    trendState: trendStateEnum("trend_state"),
    momentum: numeric("momentum", { precision: 6, scale: 5 }),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.platform, t.market, t.hashtagId] }),
    index("hashtag_daily_stats_hashtag_id_date_idx").on(t.hashtagId, t.date),
  ],
);

export const hashtagCooccurrenceDaily = pgTable(
  "hashtag_cooccurrence_daily",
  {
    date: date("date").notNull(),
    platform: platformEnum("platform").notNull(),
    market: text("market").notNull().default("global"),
    tagA: bigint("tag_a", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),
    tagB: bigint("tag_b", { mode: "number" })
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),

    posts: integer("posts").notNull().default(0),
    viralPosts: integer("viral_posts").notNull().default(0),
    viewsSum: bigint("views_sum", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.platform, t.market, t.tagA, t.tagB] }),
    // tag_a < tag_b is an application-level invariant (repository layer
    // always sorts the pair before writing) rather than a DB CHECK, so
    // PGlite/Postgres compatibility doesn't depend on a specific check-
    // constraint expression dialect — see repositories/hashtags.ts.
  ],
);

export const hashtagTierEvents = pgTable("hashtag_tier_events", {
  id: id(),
  trackedHashtagId: bigint("tracked_hashtag_id", { mode: "number" })
    .notNull()
    .references(() => trackedHashtags.id, { onDelete: "cascade" }),
  fromTier: trackingTierEnum("from_tier"),
  toTier: trackingTierEnum("to_tier").notNull(),
  reason: text("reason").notNull(),
  at: instant("at").notNull(),
});

export const scoringBaselines = pgTable(
  "scoring_baselines",
  {
    platform: platformEnum("platform").notNull(),
    market: text("market").notNull().default("global"),
    metric: text("metric").notNull(),
    computedAt: instant("computed_at").notNull(),
    n: integer("n").notNull(),
    median: numeric("median", { precision: 18, scale: 4 }).notNull(),
    mad: numeric("mad", { precision: 18, scale: 4 }).notNull(),
    p10: numeric("p10", { precision: 18, scale: 4 }),
    p90: numeric("p90", { precision: 18, scale: 4 }),
  },
  (t) => [primaryKey({ columns: [t.platform, t.market, t.metric] })],
);

// ---------------------------------------------------------------------------
// Jobs, reports, and operational tables
// ---------------------------------------------------------------------------

export const collectionRuns = pgTable("collection_runs", {
  id: id(),
  kind: collectionRunKindEnum("kind").notNull(),
  slotKey: text("slot_key").notNull().unique(),
  status: collectionRunStatusEnum("status").notNull().default("PLANNED"),

  plannedAt: instant("planned_at").notNull(),
  startedAt: instant("started_at"),
  finishedAt: instant("finished_at"),

  budgetRecords: integer("budget_records"),
  recordsUsed: integer("records_used").notNull().default(0),

  stats: jsonb("stats").$type<Record<string, unknown>>(),
  errorSummary: text("error_summary"),
  triggeredBy: text("triggered_by"),
});

export const providerJobs = pgTable(
  "provider_jobs",
  {
    id: id(),
    collectionRunId: bigint("collection_run_id", { mode: "number" })
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    platform: platformEnum("platform").notNull(),
    jobType: jobTypeEnum("job_type").notNull(),

    externalJobId: text("external_job_id"),
    webhookToken: text("webhook_token"),
    input: jsonb("input").$type<Record<string, unknown>>(),

    status: jobStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextPollAt: instant("next_poll_at"),
    leaseUntil: instant("lease_until"),

    submittedAt: instant("submitted_at"),
    completedAt: instant("completed_at"),
    ingestedAt: instant("ingested_at"),

    recordsReturned: integer("records_returned"),
    recordsQuarantined: integer("records_quarantined"),
    // Micro-dollar precision (6 decimal places) — see module doc comment
    // on money types. A string in JS, by design; never a float.
    costEstUsd: numeric("cost_est_usd", { precision: 12, scale: 6 }),
    httpMs: integer("http_ms"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("provider_jobs_provider_external_job_id_key")
      .on(t.provider, t.externalJobId)
      .where(sql`${t.externalJobId} IS NOT NULL`),
    index("provider_jobs_status_next_poll_at_idx").on(t.status, t.nextPollAt),
  ],
);

export const dailyReports = pgTable(
  "daily_reports",
  {
    id: id(),
    reportDate: date("report_date").notNull(),
    market: text("market").notNull().default("global"),

    windowStart: instant("window_start").notNull(),
    windowEnd: instant("window_end").notNull(),

    status: reportStatusEnum("status").notNull(),
    partialReasons: text("partial_reasons").array(),

    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    scoringVersion: integer("scoring_version"),
    generatedAt: instant("generated_at").notNull(),
    deliveredAt: instant("delivered_at"),
    telegramMessageIds: text("telegram_message_ids").array(),
  },
  (t) => [uniqueIndex("daily_reports_report_date_market_key").on(t.reportDate, t.market)],
);

export const resultViews = pgTable("result_views", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>(),
  items: jsonb("items").$type<unknown[]>().notNull(),
  createdAt: instant("created_at").notNull(),
  expiresAt: instant("expires_at").notNull(),
});

export const aiInsights = pgTable(
  "ai_insights",
  {
    id: id(),
    reportId: bigint("report_id", { mode: "number" }).references(() => dailyReports.id, { onDelete: "set null" }),
    inputHash: text("input_hash").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    status: aiInsightStatusEnum("status").notNull().default("PENDING"),
    rawOutput: text("raw_output"),
    parsed: jsonb("parsed").$type<Record<string, unknown>>(),
    error: text("error"),
    latencyMs: integer("latency_ms"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [uniqueIndex("ai_insights_input_hash_prompt_version_key").on(t.inputHash, t.promptVersion)],
);

export const quarantinedItems = pgTable("quarantined_items", {
  id: id(),
  provider: providerEnum("provider").notNull(),
  platform: platformEnum("platform").notNull(),
  providerJobId: bigint("provider_job_id", { mode: "number" }).references(() => providerJobs.id, {
    onDelete: "set null",
  }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  error: text("error").notNull(),
  createdAt: instant("created_at").notNull(),
});

export const telegramUpdates = pgTable("telegram_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  receivedAt: instant("received_at").notNull(),
});

export const errorEvents = pgTable("error_events", {
  id: id(),
  at: instant("at").notNull(),
  scope: text("scope").notNull(),
  severity: errorSeverityEnum("severity").notNull(),
  message: text("message").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: instant("updated_at").notNull(),
});
