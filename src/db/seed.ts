/**
 * Seeds the initial hashtag dictionary + tracked-hashtag taxonomy from
 * src/config/taxonomy.ts (Phase 3 brief §34/§35). Idempotent and
 * non-destructive: safe to run any number of times.
 *
 *   - `hashtags` / `hashtag_categories`: plain idempotent upserts.
 *   - `tracked_hashtags`: created once per (hashtag, platform, market) via
 *     `ensureTrackedHashtag`, which never touches an existing row — so a
 *     re-run never resets tier/priority/scan state that Phase 6's future
 *     lifecycle logic will have since mutated (test M in the Phase 3
 *     brief: "running seed twice produces the same logical state").
 *
 * Seeds both platforms (tiktok, instagram) for every tag, at the MVP
 * market only ("global" — see ADR-020).
 */
import { PLATFORMS } from "@/core/domain/platform.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { SEED_HASHTAGS } from "@/config/taxonomy.ts";
import type { Database } from "./client.ts";
import { upsertHashtag, upsertHashtagCategory } from "./repositories/hashtags.ts";
import { ensureTrackedHashtag } from "./repositories/tracking.ts";

export interface SeedSummary {
  hashtagsUpserted: number;
  categoriesLinked: number;
  trackedHashtagsCreated: number;
  trackedHashtagsAlreadyExisted: number;
}

export async function seedTaxonomy(db: Database, now: Date = new Date()): Promise<SeedSummary> {
  const summary: SeedSummary = {
    hashtagsUpserted: 0,
    categoriesLinked: 0,
    trackedHashtagsCreated: 0,
    trackedHashtagsAlreadyExisted: 0,
  };

  for (const seed of SEED_HASHTAGS) {
    const hashtagId = await upsertHashtag(db, seed.tag, now);
    summary.hashtagsUpserted++;

    for (const category of seed.categories) {
      await upsertHashtagCategory(db, { hashtagId, category, source: "SEED", confidence: 1 });
      summary.categoriesLinked++;
    }

    for (const platform of PLATFORMS) {
      const result = await ensureTrackedHashtag(db, {
        hashtagId,
        platform,
        market: GLOBAL_MARKET,
        tier: seed.initialTier,
        source: "SEED",
      });
      if (result.created) summary.trackedHashtagsCreated++;
      else summary.trackedHashtagsAlreadyExisted++;
    }
  }

  return summary;
}
