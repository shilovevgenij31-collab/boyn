import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../helpers/test-db.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { trackedHashtags } from "@/db/schema.ts";

describe("tracking repository", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("L: (hashtag, platform, market) uniqueness — calling twice returns the same row, not a duplicate", async () => {
    const hashtagId = await upsertHashtag(db, "tracking-l-1", new Date());

    const first = await ensureTrackedHashtag(db, {
      hashtagId,
      platform: "tiktok",
      market: "global",
      tier: "CORE",
      source: "SEED",
    });
    const second = await ensureTrackedHashtag(db, {
      hashtagId,
      platform: "tiktok",
      market: "global",
      tier: "CORE",
      source: "SEED",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.id).toBe(second.id);

    const rows = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtagId));
    expect(rows).toHaveLength(1);
  });

  it("the same hashtag is tracked independently per platform", async () => {
    const hashtagId = await upsertHashtag(db, "tracking-l-2", new Date());
    await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "CORE", source: "SEED" });
    await ensureTrackedHashtag(db, {
      hashtagId,
      platform: "instagram",
      market: "global",
      tier: "DORMANT",
      source: "SEED",
    });

    const rows = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtagId));
    expect(rows).toHaveLength(2);
  });

  it("does not reset tier on a repeated ensure call (non-destructive)", async () => {
    const hashtagId = await upsertHashtag(db, "tracking-l-3", new Date());
    await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "DORMANT", source: "SEED" });

    // Simulate Phase 6 having promoted it since.
    await db
      .update(trackedHashtags)
      .set({ tier: "ACTIVE" })
      .where(eq(trackedHashtags.hashtagId, hashtagId));

    // A re-run of seed-like logic must not put it back to DORMANT.
    await ensureTrackedHashtag(db, { hashtagId, platform: "tiktok", market: "global", tier: "DORMANT", source: "SEED" });

    const [row] = await db.select().from(trackedHashtags).where(eq(trackedHashtags.hashtagId, hashtagId));
    expect(row?.tier).toBe("ACTIVE");
  });
});
