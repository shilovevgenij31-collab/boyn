/**
 * Toggle the `collection_paused` app_setting (Phase 9 RUNBOOK operational
 * helper) — a paused tick still polls/ingests already-running provider
 * jobs, but plans no new discovery/refresh work
 * (src/jobs/plan-discovery.ts, src/db/repositories/settings.ts).
 *
 * Usage:
 *   npx tsx scripts/collection-pause.ts status
 *   npx tsx scripts/collection-pause.ts pause
 *   npx tsx scripts/collection-pause.ts resume
 */
import "./load-env.ts";
import { getDb, closeDb } from "@/db/client.ts";
import { isCollectionPaused, setCollectionPaused } from "@/db/repositories/settings.ts";

async function main(): Promise<void> {
  const action = process.argv[2];
  const db = getDb();

  if (action === "status") {
    console.log(`collection_paused = ${await isCollectionPaused(db)}`);
    return;
  }
  if (action === "pause") {
    await setCollectionPaused(db, true, new Date());
    console.log("collection_paused = true");
    return;
  }
  if (action === "resume") {
    await setCollectionPaused(db, false, new Date());
    console.log("collection_paused = false");
    return;
  }

  console.error("Usage: npx tsx scripts/collection-pause.ts <status|pause|resume>");
  process.exitCode = 1;
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error("[collection-pause] FATAL:", error instanceof Error ? error.message : String(error));
    await closeDb();
    process.exitCode = 1;
  });
