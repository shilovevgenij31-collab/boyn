import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { seedTaxonomy } from "@/db/seed.ts";
import { SEED_HASHTAGS } from "@/config/taxonomy.ts";
import { hashtags, hashtagCategories, trackedHashtags } from "@/db/schema.ts";

describe("seedTaxonomy", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  async function countAll() {
    const [h] = await db.select({ c: sql<number>`count(*)` }).from(hashtags);
    const [c] = await db.select({ c: sql<number>`count(*)` }).from(hashtagCategories);
    const [t] = await db.select({ c: sql<number>`count(*)` }).from(trackedHashtags);
    return { hashtagCount: Number(h?.c), categoryCount: Number(c?.c), trackedCount: Number(t?.c) };
  }

  it("M: running seed twice produces the same logical state (idempotent)", async () => {
    const now = new Date("2026-09-12T00:00:00.000Z");
    await seedTaxonomy(db, now);
    const afterFirst = await countAll();

    await seedTaxonomy(db, new Date("2026-09-13T00:00:00.000Z"));
    const afterSecond = await countAll();

    expect(afterSecond).toEqual(afterFirst);
  });

  it("seeds exactly the configured hashtags, both platforms each, at the global market", async () => {
    const rows = await db.select({ platform: trackedHashtags.platform, market: trackedHashtags.market }).from(trackedHashtags);
    expect(rows).toHaveLength(SEED_HASHTAGS.length * 2);
    expect(rows.every((r) => r.market === "global")).toBe(true);
    expect(rows.filter((r) => r.platform === "tiktok")).toHaveLength(SEED_HASHTAGS.length);
    expect(rows.filter((r) => r.platform === "instagram")).toHaveLength(SEED_HASHTAGS.length);
  });

  it("preserves each seed's configured initial tier (e.g. #cosplay starts CORE)", async () => {
    const [hashtag] = await db.select().from(hashtags).where(sql`${hashtags.name} = 'cosplay'`);
    expect(hashtag).toBeDefined();
    const rows = await db
      .select({ tier: trackedHashtags.tier })
      .from(trackedHashtags)
      .where(sql`${trackedHashtags.hashtagId} = ${hashtag!.id} AND ${trackedHashtags.platform} = 'tiktok'`);
    expect(rows[0]?.tier).toBe("CORE");
  });

  it("does not reset a tier that lifecycle logic changed after the initial seed", async () => {
    const [hashtag] = await db.select().from(hashtags).where(sql`${hashtags.name} = 'cosplaygirl'`);
    // seeded as DORMANT; simulate a promotion having happened since.
    await db
      .update(trackedHashtags)
      .set({ tier: "ACTIVE" })
      .where(sql`${trackedHashtags.hashtagId} = ${hashtag!.id} AND ${trackedHashtags.platform} = 'tiktok'`);

    await seedTaxonomy(db, new Date());

    const rows = await db
      .select({ tier: trackedHashtags.tier })
      .from(trackedHashtags)
      .where(sql`${trackedHashtags.hashtagId} = ${hashtag!.id} AND ${trackedHashtags.platform} = 'tiktok'`);
    expect(rows[0]?.tier).toBe("ACTIVE");
  });
});
