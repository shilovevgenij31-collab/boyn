/**
 * Proves the full offline pipeline: a REAL sanitized fixture captured in
 * Phase 1/1B -> a REAL Phase 2 normalizer -> NormalizedPost -> the actual
 * database, through the actual repository layer. No network, no
 * artificial-only test data (Phase 3 brief §40).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { normalizeApifyTikTok } from "@/providers/apify/normalize-tiktok.ts";
import { normalizeApifyInstagram } from "@/providers/apify/normalize-instagram.ts";
import { normalizeBrightDataTikTok } from "@/providers/brightdata/normalize-tiktok.ts";
import { persistNormalizedObservation } from "@/db/repositories/posts.ts";
import { posts, hashtags, postHashtags } from "@/db/schema.ts";

function loadFixture(relativePath: string): unknown {
  const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
  return JSON.parse(readFileSync(fixturesRoot + relativePath, "utf8"));
}

const CONTEXT = { observedAt: new Date("2026-09-12T18:00:00.000Z"), discoveryMethod: "search" };

describe("real fixture -> normalizer -> database", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("persists a real Apify TikTok fixture end to end", async () => {
    const raw = loadFixture("apify/tiktok/search-1.json");
    const result = normalizeApifyTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = await persistNormalizedObservation(db, { post: result.post, snapshotSource: "DISCOVERY" });
    expect(persisted.wasNewPost).toBe(true);

    const [row] = await db.select().from(posts).where(eq(posts.id, persisted.postId));
    expect(row?.platform).toBe("tiktok");
    expect(row?.externalId).toBe("7684691961873272094");
    expect(row?.canonicalUrl).toBe("https://www.tiktok.com/@celebi.cos/video/7684691961873272094");
    expect(row?.views).toBe(8831);

    const tagRows = await db
      .select({ name: hashtags.name })
      .from(postHashtags)
      .innerJoin(hashtags, eq(hashtags.id, postHashtags.hashtagId))
      .where(eq(postHashtags.postId, persisted.postId));
    expect(tagRows.map((t) => t.name).sort()).toEqual(["cosplay", "dancetrend", "hatsunemiku"]);
  });

  it("persists a real Apify Instagram fixture end to end, including the -1 hidden-likes sentinel as null", async () => {
    const raw = loadFixture("apify/instagram/sample-1.json");
    const result = normalizeApifyInstagram(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = await persistNormalizedObservation(db, { post: result.post, snapshotSource: "DISCOVERY" });
    const [row] = await db.select().from(posts).where(eq(posts.id, persisted.postId));
    expect(row?.platform).toBe("instagram");
    expect(row?.externalId).toBe("DdME5ezS62g");
    expect(row?.canonicalUrl).toBe("https://www.instagram.com/p/DdME5ezS62g/");
    expect(row?.likes).toBeNull();
    expect(row?.views).toBe(2520);
    expect(row?.viewsMetric).toBe("ig_apify_video_play_count");
  });

  it("persists a real Bright Data TikTok fixture end to end, with the handle correctly resolved from the URL", async () => {
    const raw = loadFixture("brightdata/tiktok/sample-1b-1.json");
    const result = normalizeBrightDataTikTok(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = await persistNormalizedObservation(db, { post: result.post, snapshotSource: "DISCOVERY" });
    const [row] = await db.select().from(posts).where(eq(posts.id, persisted.postId));
    expect(row?.externalId).toBe("7684005032081067295");
    expect(row?.creatorUsername).toBe("irisinribbons");
    // share_count was a numeric STRING ("9") in the raw fixture.
    expect(row?.shares).toBe(9);
  });

  it("cross-provider dedup with REAL fixtures: the Apify TikTok search result and a synthesized Bright Data view of the same post converge to one row", async () => {
    const apifyRaw = loadFixture("apify/tiktok/search-1.json") as Record<string, unknown>;
    const apifyResult = normalizeApifyTikTok(apifyRaw, CONTEXT);
    expect(apifyResult.ok).toBe(true);
    if (!apifyResult.ok) return;

    // Same real post id, as Bright Data's schema would report it —
    // built from the real Bright Data fixture shape (sample-1b-1.json),
    // not an invented one, with just the identity fields swapped to
    // match the Apify post above.
    const brightDataRaw = loadFixture("brightdata/tiktok/sample-1b-1.json") as Record<string, unknown>;
    const syntheticBrightData = {
      ...brightDataRaw,
      post_id: apifyResult.post.externalId,
      url: apifyResult.post.canonicalUrl,
    };
    const bdResult = normalizeBrightDataTikTok(syntheticBrightData, CONTEXT);
    expect(bdResult.ok).toBe(true);
    if (!bdResult.ok) return;

    const first = await persistNormalizedObservation(db, { post: apifyResult.post, snapshotSource: "DISCOVERY" });
    const second = await persistNormalizedObservation(db, { post: bdResult.post, snapshotSource: "DISCOVERY" });

    expect(first.postId).toBe(second.postId);
    const rows = await db.select().from(posts).where(eq(posts.externalId, apifyResult.post.externalId));
    expect(rows).toHaveLength(1);
  });
});
