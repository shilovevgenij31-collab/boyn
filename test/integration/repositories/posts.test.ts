import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../helpers/test-db.ts";
import { fakeNormalizedPost } from "../helpers/fake-post.ts";
import {
  attachPostHashtags,
  getPostByPlatformExternalId,
  insertPostSnapshot,
  persistNormalizedObservation,
  upsertNormalizedPost,
} from "@/db/repositories/posts.ts";
import { posts, postSnapshots, postHashtags } from "@/db/schema.ts";

describe("posts repository", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("B: inserting the same (platform, external_id) twice yields exactly one row", async () => {
    const post = fakeNormalizedPost({ externalId: "post-b-1" });
    await upsertNormalizedPost(db, post);
    await upsertNormalizedPost(db, post);

    const rows = await db.select().from(posts).where(eq(posts.externalId, "post-b-1"));
    expect(rows).toHaveLength(1);
  });

  it("C: the same TikTok id from Apify and then Bright Data deduplicates to one row", async () => {
    const apifyPost = fakeNormalizedPost({
      externalId: "post-c-1",
      source: { provider: "apify", discoveryMethod: "search" },
      metrics: { views: 5000, viewsMetric: "tt_apify_play_count", likes: 100, comments: 10, shares: 5, saves: 2 },
    });
    const brightDataPost = fakeNormalizedPost({
      externalId: "post-c-1",
      source: { provider: "brightdata", discoveryMethod: "keyword" },
      metrics: {
        views: 5200,
        viewsMetric: "tt_brightdata_play_count",
        likes: 105,
        comments: 11,
        shares: 6,
        saves: 3,
      },
    });

    const first = await upsertNormalizedPost(db, apifyPost);
    const second = await upsertNormalizedPost(db, brightDataPost);

    expect(first.postId).toBe(second.postId);
    expect(second.wasNewPost).toBe(false);

    const rows = await db.select().from(posts).where(eq(posts.externalId, "post-c-1"));
    expect(rows).toHaveLength(1);
    // Latest observation (Bright Data) wins for the convenience columns.
    expect(rows[0]?.views).toBe(5200);
    expect(rows[0]?.viewsMetric).toBe("tt_brightdata_play_count");
  });

  it("D: first_seen_at does not change on rediscovery", async () => {
    const firstObservedAt = new Date("2026-09-10T00:00:00.000Z");
    const laterObservedAt = new Date("2026-09-12T00:00:00.000Z");

    const { postId: id1 } = await upsertNormalizedPost(
      db,
      fakeNormalizedPost({ externalId: "post-d-1", observedAt: firstObservedAt }),
    );
    await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-d-1", observedAt: laterObservedAt }));

    const [row] = await db.select().from(posts).where(eq(posts.id, id1));
    expect(row?.firstSeenAt.toISOString()).toBe(firstObservedAt.toISOString());
  });

  it("E: last_seen_at advances to the most recent observation", async () => {
    const firstObservedAt = new Date("2026-09-10T00:00:00.000Z");
    const laterObservedAt = new Date("2026-09-12T00:00:00.000Z");

    const { postId } = await upsertNormalizedPost(
      db,
      fakeNormalizedPost({ externalId: "post-e-1", observedAt: firstObservedAt }),
    );
    await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-e-1", observedAt: laterObservedAt }));

    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(row?.lastSeenAt.toISOString()).toBe(laterObservedAt.toISOString());
  });

  it("F: an existing useful metric is not replaced by a later null", async () => {
    const { postId } = await upsertNormalizedPost(
      db,
      fakeNormalizedPost({
        externalId: "post-f-1",
        metrics: { views: 1000, viewsMetric: "tt_apify_play_count", likes: 100, comments: 10, shares: 800, saves: 2 },
      }),
    );

    // A later, degraded observation with shares missing entirely.
    await upsertNormalizedPost(
      db,
      fakeNormalizedPost({
        externalId: "post-f-1",
        observedAt: new Date("2026-09-13T00:00:00.000Z"),
        metrics: { views: 1200, viewsMetric: "tt_apify_play_count", likes: 110, comments: 12, shares: null, saves: null },
      }),
    );

    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    // shares/saves keep their previously-known value...
    expect(row?.shares).toBe(800);
    expect(row?.saves).toBe(2);
    // ...while fields that DID arrive this time are updated.
    expect(row?.views).toBe(1200);
    expect(row?.likes).toBe(110);
  });

  it("F (also caption/creator): missing caption/follower data on a later observation keeps the prior value", async () => {
    const { postId } = await upsertNormalizedPost(
      db,
      fakeNormalizedPost({
        externalId: "post-f-2",
        caption: "original caption",
        creator: { username: "tester", externalId: "c1", followers: 5000, verified: true },
      }),
    );
    await upsertNormalizedPost(
      db,
      fakeNormalizedPost({
        externalId: "post-f-2",
        observedAt: new Date("2026-09-13T00:00:00.000Z"),
        caption: null,
        creator: { username: "tester", externalId: "c1", followers: null, verified: null },
      }),
    );

    const [row] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(row?.caption).toBe("original caption");
    expect(row?.creatorFollowers).toBe(5000);
    expect(row?.creatorVerified).toBe(true);
  });

  it("G: two distinct legitimate observations create two historical snapshots", async () => {
    const { postId } = await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-g-1" }));

    const inserted1 = await insertPostSnapshot(db, {
      postId,
      observedAt: new Date("2026-09-10T10:00:00.000Z"),
      metrics: { views: 1000, viewsMetric: "tt_apify_play_count", likes: 10, comments: 1, shares: 1, saves: 0 },
      source: "DISCOVERY",
    });
    const inserted2 = await insertPostSnapshot(db, {
      postId,
      observedAt: new Date("2026-09-10T14:00:00.000Z"),
      metrics: { views: 5000, viewsMetric: "tt_apify_play_count", likes: 50, comments: 5, shares: 4, saves: 2 },
      source: "REFRESH",
    });

    expect(inserted1).toBe(true);
    expect(inserted2).toBe(true);

    const rows = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    expect(rows).toHaveLength(2);
  });

  it("H: re-ingesting an identical observation within the dedup window does not duplicate the snapshot", async () => {
    const { postId } = await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-h-1" }));

    const metrics = { views: 2000, viewsMetric: "tt_apify_play_count" as const, likes: 20, comments: 2, shares: 2, saves: 1 };
    const observedAt = new Date("2026-09-10T10:00:00.000Z");

    const first = await insertPostSnapshot(db, { postId, observedAt, metrics, source: "DISCOVERY" });
    // Same metrics, 1 minute later — the same underlying observation
    // re-ingested (e.g. a retried job), not a real new data point.
    const second = await insertPostSnapshot(db, {
      postId,
      observedAt: new Date(observedAt.getTime() + 60_000),
      metrics,
      source: "DISCOVERY",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    expect(rows).toHaveLength(1);
  });

  it("H (negative case): different metrics within the same window still create a new snapshot", async () => {
    const { postId } = await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-h-2" }));
    const observedAt = new Date("2026-09-10T10:00:00.000Z");

    await insertPostSnapshot(db, {
      postId,
      observedAt,
      metrics: { views: 2000, viewsMetric: "tt_apify_play_count", likes: 20, comments: 2, shares: 2, saves: 1 },
      source: "DISCOVERY",
    });
    const second = await insertPostSnapshot(db, {
      postId,
      observedAt: new Date(observedAt.getTime() + 60_000),
      // genuinely grew
      metrics: { views: 9000, viewsMetric: "tt_apify_play_count", likes: 90, comments: 9, shares: 9, saves: 4 },
      source: "DISCOVERY",
    });

    expect(second).toBe(true);
    const rows = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    expect(rows).toHaveLength(2);
  });

  it("N: deleting a post cascades to its snapshots and post_hashtags", async () => {
    const { postId } = await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-n-1" }));
    await insertPostSnapshot(db, {
      postId,
      observedAt: new Date(),
      metrics: { views: 1, viewsMetric: "tt_apify_play_count", likes: null, comments: null, shares: null, saves: null },
      source: "DISCOVERY",
    });
    await attachPostHashtags(db, postId, ["cascadetest"], new Date());

    await db.delete(posts).where(eq(posts.id, postId));

    const snapshotRows = await db.select().from(postSnapshots).where(eq(postSnapshots.postId, postId));
    const hashtagRows = await db.select().from(postHashtags).where(eq(postHashtags.postId, postId));
    expect(snapshotRows).toHaveLength(0);
    expect(hashtagRows).toHaveLength(0);
  });

  it("persistNormalizedObservation: one call atomically creates the post, hashtags, and a snapshot", async () => {
    const post = fakeNormalizedPost({ externalId: "post-atomic-1", hashtags: ["cosplay", "gaming"] });
    const result = await persistNormalizedObservation(db, { post, snapshotSource: "DISCOVERY" });

    expect(result.wasNewPost).toBe(true);
    expect(result.snapshotInserted).toBe(true);
    expect(result.hashtagIds).toHaveLength(2);

    const snapshotRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(postSnapshots)
      .where(eq(postSnapshots.postId, result.postId));
    expect(Number(snapshotRows[0]?.c)).toBe(1);
  });

  it("getPostByPlatformExternalId finds an existing post and returns null for a missing one", async () => {
    await upsertNormalizedPost(db, fakeNormalizedPost({ externalId: "post-lookup-1" }));
    const found = await getPostByPlatformExternalId(db, "tiktok", "post-lookup-1");
    const missing = await getPostByPlatformExternalId(db, "tiktok", "does-not-exist");
    expect(found?.externalId).toBe("post-lookup-1");
    expect(missing).toBeNull();
  });
});
