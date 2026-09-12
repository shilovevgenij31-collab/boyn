/**
 * Seeds the initial hashtag taxonomy into the database pointed to by
 * DATABASE_URL. Run via `npm run db:seed` (uses tsx so this can import
 * the real, tested src/db/seed.ts through the project's normal `@/`
 * path aliases — see package.json for why tsx specifically).
 */
import { getDb, closeDb } from "@/db/client.ts";
import { seedTaxonomy } from "@/db/seed.ts";

async function main(): Promise<void> {
  const db = getDb();
  const summary = await seedTaxonomy(db);
  console.log(`[db:seed] hashtags upserted: ${summary.hashtagsUpserted}`);
  console.log(`[db:seed] category links: ${summary.categoriesLinked}`);
  console.log(`[db:seed] tracked hashtags created: ${summary.trackedHashtagsCreated}`);
  console.log(`[db:seed] tracked hashtags already present: ${summary.trackedHashtagsAlreadyExisted}`);
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error("[db:seed] FATAL:", error instanceof Error ? error.message : String(error));
    await closeDb();
    process.exitCode = 1;
  });
