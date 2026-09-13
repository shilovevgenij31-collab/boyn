import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { hashtagCategories, hashtags } from "@/db/schema.ts";
import type { Category } from "@/core/domain/category.ts";

/**
 * Hashtag names arriving here are already normalized by
 * core/normalize/hashtags.ts before persistence (no leading "#", NFKC,
 * lowercase) — this repository trusts and enforces uniqueness on
 * `name`, it does not re-normalize (Phase 3 brief §9).
 */
export async function upsertHashtag(db: Database, name: string, observedAt: Date): Promise<number> {
  const rows = await db
    .insert(hashtags)
    .values({ name, firstSeenAt: observedAt, lastSeenAt: observedAt })
    .onConflictDoUpdate({
      target: hashtags.name,
      set: { lastSeenAt: sql.raw('excluded."last_seen_at"') },
      // first_seen_at intentionally omitted — keeps the original value.
    })
    .returning({ id: hashtags.id });

  const row = rows[0];
  if (!row) throw new Error(`upsertHashtag: no row returned for "${name}"`);
  return row.id;
}

/** Upserts each name, preserving input order in the returned id list
 * (needed by attachPostHashtags for `position`). One upsert per name
 * rather than a single bulk statement — hashtag lists per post are small
 * (rarely >20) and this keeps the id-to-name ordering exact rather than
 * relying on Postgres's unspecified row order for a bulk RETURNING. */
export async function upsertHashtags(db: Database, names: string[], observedAt: Date): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    ids.push(await upsertHashtag(db, name, observedAt));
  }
  return ids;
}

export interface HashtagRow {
  id: number;
  name: string;
  isGeneric: boolean;
  isBlocked: boolean;
}

export async function getHashtagByName(db: Database, name: string): Promise<HashtagRow | null> {
  const rows = await db
    .select({ id: hashtags.id, name: hashtags.name, isGeneric: hashtags.isGeneric, isBlocked: hashtags.isBlocked })
    .from(hashtags)
    .where(eq(hashtags.name, name))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertHashtagCategoryParams {
  hashtagId: number;
  category: Category;
  source: "SEED" | "KEYWORD" | "COOCCURRENCE" | "MANUAL" | "AI";
  confidence: number;
}

/** Idempotent, non-destructive (Phase 3 brief §14/§34): a seed run that
 * finds the (hashtag, category) pair already recorded leaves it alone —
 * no classification logic exists yet to decide whether a later `source`
 * should win, so this never overwrites. */
export async function upsertHashtagCategory(db: Database, params: UpsertHashtagCategoryParams): Promise<void> {
  await db
    .insert(hashtagCategories)
    .values({
      hashtagId: params.hashtagId,
      category: params.category,
      source: params.source,
      confidence: params.confidence.toString(),
    })
    .onConflictDoNothing({ target: [hashtagCategories.hashtagId, hashtagCategories.category] });
}

export async function getHashtagCategories(
  db: Database,
  hashtagId: number,
): Promise<{ category: Category; source: string; confidence: string }[]> {
  return db
    .select({
      category: hashtagCategories.category,
      source: hashtagCategories.source,
      confidence: hashtagCategories.confidence,
    })
    .from(hashtagCategories)
    .where(and(eq(hashtagCategories.hashtagId, hashtagId)));
}

/** Batched version for analytics (Phase 6 brief §50: avoid N+1) — one
 * query for every hashtag id referenced across a whole analytics run. */
export async function getHashtagCategoriesBulk(
  db: Database,
  hashtagIds: number[],
): Promise<{ hashtagId: number; category: Category; confidence: string }[]> {
  if (hashtagIds.length === 0) return [];
  return db
    .select({ hashtagId: hashtagCategories.hashtagId, category: hashtagCategories.category, confidence: hashtagCategories.confidence })
    .from(hashtagCategories)
    .where(inArray(hashtagCategories.hashtagId, hashtagIds));
}
