import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../helpers/test-db.ts";
import { fakeNormalizedPost } from "../helpers/fake-post.ts";
import { getHashtagByName, upsertHashtag, upsertHashtags } from "@/db/repositories/hashtags.ts";
import { attachPostHashtags, upsertNormalizedPost } from "@/db/repositories/posts.ts";
import { hashtags, postHashtags } from "@/db/schema.ts";

describe("hashtags repository", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("I: the same hashtag name only ever exists once", async () => {
    const now = new Date();
    const id1 = await upsertHashtag(db, "cosplay", now);
    const id2 = await upsertHashtag(db, "cosplay", now);
    expect(id1).toBe(id2);

    const rows = await db.select().from(hashtags).where(eq(hashtags.name, "cosplay"));
    expect(rows).toHaveLength(1);
  });

  it("I: does not change first_seen_at on a later upsert, but advances last_seen_at", async () => {
    const first = new Date("2026-09-01T00:00:00.000Z");
    const later = new Date("2026-09-10T00:00:00.000Z");
    const id = await upsertHashtag(db, "gaming-i", first);
    await upsertHashtag(db, "gaming-i", later);

    const [row] = await db.select().from(hashtags).where(eq(hashtags.id, id));
    expect(row?.firstSeenAt.toISOString()).toBe(first.toISOString());
    expect(row?.lastSeenAt.toISOString()).toBe(later.toISOString());
  });

  it("upsertHashtags preserves input order in the returned ids", async () => {
    const now = new Date();
    const ids = await upsertHashtags(db, ["alpha-tag", "beta-tag", "gamma-tag"], now);
    const names = await Promise.all(
      ids.map(async (id) => (await db.select().from(hashtags).where(eq(hashtags.id, id)))[0]?.name),
    );
    expect(names).toEqual(["alpha-tag", "beta-tag", "gamma-tag"]);
  });

  it("J: replaying the same post+hashtags does not duplicate post_hashtags associations", async () => {
    const post = fakeNormalizedPost({ externalId: "post-j-1", hashtags: ["cosplay", "gaming"] });
    const { postId } = await upsertNormalizedPost(db, post);

    await attachPostHashtags(db, postId, post.hashtags, post.observedAt);
    await attachPostHashtags(db, postId, post.hashtags, post.observedAt);

    const rows = await db.select().from(postHashtags).where(eq(postHashtags.postId, postId));
    expect(rows).toHaveLength(2);
  });

  it("K: a later observation with an additional tag adds it without removing existing associations", async () => {
    const post = fakeNormalizedPost({ externalId: "post-k-1", hashtags: ["cosplay"] });
    const { postId } = await upsertNormalizedPost(db, post);
    await attachPostHashtags(db, postId, ["cosplay"], post.observedAt);

    // Rediscovered later with an extra tag, and (importantly) WITHOUT
    // "cosplay" explicitly re-listed in this particular result — a
    // provider omitting a tag it found before must not be treated as
    // "remove cosplay".
    await attachPostHashtags(db, postId, ["gaming"], new Date());

    const rows = await db
      .select({ name: hashtags.name })
      .from(postHashtags)
      .innerJoin(hashtags, eq(hashtags.id, postHashtags.hashtagId))
      .where(eq(postHashtags.postId, postId));
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["cosplay", "gaming"]);
  });

  it("getHashtagByName returns null for an unknown tag", async () => {
    expect(await getHashtagByName(db, "does-not-exist-tag")).toBeNull();
  });
});
