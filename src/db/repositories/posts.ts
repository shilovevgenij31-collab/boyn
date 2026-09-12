import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client.ts";
import { postDiscoveries, postHashtags, posts, postSnapshots } from "@/db/schema.ts";
import type { NormalizedPost } from "@/core/domain/social-post.ts";
import { upsertHashtags } from "./hashtags.ts";

/** References the proposed-insert row's column inside an `ON CONFLICT DO
 * UPDATE SET` clause. Column names here are always our own fixed schema
 * identifiers (never user input), so raw interpolation is safe. */
function excludedColumn(column: string): SQL {
  return sql.raw(`excluded."${column}"`);
}

/** `COALESCE(excluded.<column>, <table>.<column>)` — the null-safe merge
 * rule everywhere in this repository (Phase 3 brief §30): a later
 * observation that simply didn't carry a value must never blank out a
 * previously known one. */
function keepIfNull(column: string, existing: PgColumn): SQL {
  return sql`coalesce(${excludedColumn(column)}, ${existing})`;
}

function toDurationString(durationSec: number | null): string | null {
  return durationSec === null ? null : durationSec.toFixed(3);
}

export interface UpsertPostResult {
  postId: number;
  wasNewPost: boolean;
}

/**
 * Idempotent upsert on `(platform, external_id)` — the canonical dedup
 * key (Phase 3 brief §6/§31). The SAME row is produced whether a TikTok
 * post arrived via Apify or Bright Data; provider identity is never part
 * of the uniqueness key.
 *
 * Merge semantics: `first_seen_at` is only ever set on the initial
 * INSERT (deliberately absent from the `set` clause, so a conflict never
 * touches it). Every other soft field uses `keepIfNull` — a `null` in the
 * new observation keeps whatever was already stored, it never clobbers a
 * previously-known value. `canonical_url`/`content_type` always take the
 * latest value since NormalizedPost guarantees them non-null.
 */
export async function upsertNormalizedPost(db: Database, post: NormalizedPost): Promise<UpsertPostResult> {
  const rows = await db
    .insert(posts)
    .values({
      platform: post.platform,
      externalId: post.externalId,
      market: "global",
      language: null,
      canonicalUrl: post.canonicalUrl,
      contentType: post.contentType,
      creatorUsername: post.creator.username,
      creatorExternalId: post.creator.externalId,
      creatorFollowers: post.creator.followers,
      creatorVerified: post.creator.verified,
      caption: post.caption,
      musicId: post.music?.id ?? null,
      musicTitle: post.music?.title ?? null,
      musicAuthor: post.music?.author ?? null,
      publishedAt: post.publishedAt,
      durationSec: toDurationString(post.durationSec),
      views: post.metrics.views,
      viewsMetric: post.metrics.viewsMetric,
      likes: post.metrics.likes,
      comments: post.metrics.comments,
      shares: post.metrics.shares,
      saves: post.metrics.saves,
      firstSeenAt: post.observedAt,
      lastSeenAt: post.observedAt,
    })
    .onConflictDoUpdate({
      target: [posts.platform, posts.externalId],
      set: {
        canonicalUrl: excludedColumn("canonical_url"),
        contentType: excludedColumn("content_type"),
        creatorUsername: keepIfNull("creator_username", posts.creatorUsername),
        creatorExternalId: keepIfNull("creator_external_id", posts.creatorExternalId),
        creatorFollowers: keepIfNull("creator_followers", posts.creatorFollowers),
        creatorVerified: keepIfNull("creator_verified", posts.creatorVerified),
        caption: keepIfNull("caption", posts.caption),
        musicId: keepIfNull("music_id", posts.musicId),
        musicTitle: keepIfNull("music_title", posts.musicTitle),
        musicAuthor: keepIfNull("music_author", posts.musicAuthor),
        publishedAt: keepIfNull("published_at", posts.publishedAt),
        durationSec: keepIfNull("duration_sec", posts.durationSec),
        views: keepIfNull("views", posts.views),
        viewsMetric: keepIfNull("views_metric", posts.viewsMetric),
        likes: keepIfNull("likes", posts.likes),
        comments: keepIfNull("comments", posts.comments),
        shares: keepIfNull("shares", posts.shares),
        saves: keepIfNull("saves", posts.saves),
        lastSeenAt: excludedColumn("last_seen_at"),
        // first_seen_at intentionally omitted — keeps its original value.
      },
    })
    .returning({
      id: posts.id,
      // Postgres system column: 0 only for the row this exact statement
      // inserted; any other value means ON CONFLICT DO UPDATE fired
      // instead. The standard, reliable way to distinguish the two
      // outcomes of one upsert statement.
      wasInserted: sql<boolean>`(xmax = 0)`,
    });

  const row = rows[0];
  if (!row) {
    throw new Error("upsertNormalizedPost: insert/update returned no row");
  }
  return { postId: row.id, wasNewPost: row.wasInserted };
}

export interface PostRow {
  id: number;
  platform: string;
  externalId: string;
}

export async function getPostByPlatformExternalId(
  db: Database,
  platform: NormalizedPost["platform"],
  externalId: string,
): Promise<PostRow | null> {
  const rows = await db
    .select({ id: posts.id, platform: posts.platform, externalId: posts.externalId })
    .from(posts)
    .where(and(eq(posts.platform, platform), eq(posts.externalId, externalId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface InsertSnapshotParams {
  postId: number;
  observedAt: Date;
  metrics: NormalizedPost["metrics"];
  source: "DISCOVERY" | "REFRESH";
  providerJobId?: number | null;
}

/**
 * Append-only observation history (Phase 3 brief §8/§32). Dedup strategy:
 * rather than a rigid unique constraint (documented as unreliable in
 * schema.ts — provider_job_id is nullable and one job can legitimately
 * match the same post twice), this skips the insert when the single most
 * recent snapshot for this post already reports IDENTICAL metrics within
 * a short window (5 minutes) — covering "re-ingesting the same
 * observation" without rejecting two genuinely different observations
 * that happen to share a null job id.
 */
export async function insertPostSnapshot(db: Database, params: InsertSnapshotParams): Promise<boolean> {
  const DEDUP_WINDOW_MS = 5 * 60_000;

  const [latest] = await db
    .select({
      observedAt: postSnapshots.observedAt,
      views: postSnapshots.views,
      likes: postSnapshots.likes,
      comments: postSnapshots.comments,
      shares: postSnapshots.shares,
      saves: postSnapshots.saves,
    })
    .from(postSnapshots)
    .where(eq(postSnapshots.postId, params.postId))
    .orderBy(sql`${postSnapshots.observedAt} desc`)
    .limit(1);

  if (latest) {
    const withinWindow =
      Math.abs(params.observedAt.getTime() - latest.observedAt.getTime()) <= DEDUP_WINDOW_MS;
    const sameMetrics =
      latest.views === params.metrics.views &&
      latest.likes === params.metrics.likes &&
      latest.comments === params.metrics.comments &&
      latest.shares === params.metrics.shares &&
      latest.saves === params.metrics.saves;
    if (withinWindow && sameMetrics) {
      return false;
    }
  }

  await db.insert(postSnapshots).values({
    postId: params.postId,
    observedAt: params.observedAt,
    views: params.metrics.views,
    viewsMetric: params.metrics.viewsMetric,
    likes: params.metrics.likes,
    comments: params.metrics.comments,
    shares: params.metrics.shares,
    saves: params.metrics.saves,
    source: params.source,
    providerJobId: params.providerJobId ?? null,
  });
  return true;
}

/**
 * Idempotently unions a post's hashtags with whatever was already
 * associated (Phase 3 brief §10/§39-K): a rediscovery that reveals a new
 * tag ADDS it; it never removes a previously-recorded association just
 * because this particular provider result omitted a tag the post is
 * still known to carry.
 */
export async function attachPostHashtags(
  db: Database,
  postId: number,
  hashtagNames: string[],
  observedAt: Date,
): Promise<number[]> {
  if (hashtagNames.length === 0) return [];

  const hashtagIds = await upsertHashtags(db, hashtagNames, observedAt);

  await db
    .insert(postHashtags)
    .values(hashtagIds.map((hashtagId, index) => ({ postId, hashtagId, position: index })))
    .onConflictDoNothing({ target: [postHashtags.postId, postHashtags.hashtagId] });

  return hashtagIds;
}

export interface DiscoveryProvenance {
  postId: number;
  providerJobId: number;
  hashtagId?: number | null;
  queryText?: string | null;
  rankInResults?: number | null;
  observedAt: Date;
}

/** One row per (post, provider job) — a post rediscovered by a later job
 * gets a SECOND provenance row, which is the point (query yield, hashtag
 * performance — Phase 3 brief §11), not something to deduplicate away. */
export async function recordPostDiscovery(db: Database, params: DiscoveryProvenance): Promise<void> {
  await db
    .insert(postDiscoveries)
    .values({
      postId: params.postId,
      providerJobId: params.providerJobId,
      hashtagId: params.hashtagId ?? null,
      queryText: params.queryText ?? null,
      rankInResults: params.rankInResults ?? null,
      observedAt: params.observedAt,
    })
    .onConflictDoNothing({ target: [postDiscoveries.postId, postDiscoveries.providerJobId] });
}

export interface PersistObservationParams {
  post: NormalizedPost;
  snapshotSource: "DISCOVERY" | "REFRESH";
  providerJobId?: number | null;
  discovery?: {
    hashtagId?: number | null;
    queryText?: string | null;
    rankInResults?: number | null;
  };
}

export interface PersistObservationResult {
  postId: number;
  wasNewPost: boolean;
  snapshotInserted: boolean;
  hashtagIds: number[];
}

/**
 * The one atomic operation everything else in this module composes into
 * (Phase 3 brief §33): upsert the post, union its hashtags, append a
 * snapshot, and (if this observation came from a specific job/query)
 * record discovery provenance — all in one transaction, so a post is
 * never left half-persisted (e.g. hashtags attached but no snapshot) by
 * a failure partway through.
 */
export async function persistNormalizedObservation(
  db: Database,
  params: PersistObservationParams,
): Promise<PersistObservationResult> {
  return db.transaction(async (tx) => {
    const { postId, wasNewPost } = await upsertNormalizedPost(tx, params.post);
    const hashtagIds = await attachPostHashtags(tx, postId, params.post.hashtags, params.post.observedAt);
    const snapshotInserted = await insertPostSnapshot(tx, {
      postId,
      observedAt: params.post.observedAt,
      metrics: params.post.metrics,
      source: params.snapshotSource,
      providerJobId: params.providerJobId ?? null,
    });

    if (params.discovery && params.providerJobId) {
      await recordPostDiscovery(tx, {
        postId,
        providerJobId: params.providerJobId,
        hashtagId: params.discovery.hashtagId ?? null,
        queryText: params.discovery.queryText ?? null,
        rankInResults: params.discovery.rankInResults ?? null,
        observedAt: params.post.observedAt,
      });
    }

    return { postId, wasNewPost, snapshotInserted, hashtagIds };
  });
}
