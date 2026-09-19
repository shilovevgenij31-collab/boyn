/**
 * `telegram_updates` dedup (Phase 8/9 production hotfix — see
 * src/app/api/telegram/webhook/route.ts's module comment for the full
 * incident). Strategy: claim, then process SYNCHRONOUSLY, then release
 * the claim on failure.
 *
 * `tryClaimUpdate` inserts `update_id` with `ON CONFLICT DO NOTHING`
 * BEFORE the router runs any command handler. A `true` result means this
 * is the first delivery — proceed. `false` means either a genuine
 * redelivery of an already-fully-processed update, OR (rare) a
 * concurrent redelivery arriving while the first attempt is still
 * in-flight — either way, skip all side effects and just acknowledge;
 * accepting that narrow concurrent-duplicate race is far preferable to
 * losing an update outright.
 *
 * The webhook route awaits the ENTIRE command synchronously before
 * responding to Telegram, and on failure calls `releaseClaim` to delete
 * the row it just inserted — so a genuine processing failure leaves the
 * update UNCLAIMED, and Telegram's own automatic webhook retry (it
 * retries a non-2xx response) can actually reprocess it instead of the
 * update being silently, permanently dropped. This replaced an earlier
 * "claim, return 200, then process in the background" design: that
 * design claimed the update BEFORE the send actually happened, so if the
 * background work was ever cut short by the serverless runtime (observed
 * in production — see the route's module comment), the update was
 * already marked processed and could never be retried, even though the
 * user never received a reply.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { telegramUpdates } from "@/db/schema.ts";

export async function tryClaimUpdate(db: Database, updateId: number, receivedAt: Date): Promise<boolean> {
  const rows = await db.insert(telegramUpdates).values({ updateId, receivedAt }).onConflictDoNothing({ target: telegramUpdates.updateId }).returning({ updateId: telegramUpdates.updateId });
  return rows.length > 0;
}

/** Deletes a claim this same request just inserted, so a later Telegram
 * retry of the same `update_id` can reprocess it — called only when
 * processing failed after a successful claim. Best-effort: a failure
 * here is logged by the caller, never thrown further (the original
 * processing error is what matters). */
export async function releaseClaim(db: Database, updateId: number): Promise<void> {
  await db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, updateId));
}

export async function wasUpdateClaimed(db: Database, updateId: number): Promise<boolean> {
  const rows = await db.select({ updateId: telegramUpdates.updateId }).from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)).limit(1);
  return rows.length > 0;
}
