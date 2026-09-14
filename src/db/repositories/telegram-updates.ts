/**
 * `telegram_updates` dedup (Phase 8 brief §11). Chosen strategy —
 * claim-before-execute: `tryClaimUpdate` inserts `update_id` with
 * `ON CONFLICT DO NOTHING` BEFORE the router runs any command handler.
 * A `true` result means this is the first delivery — proceed. `false`
 * means it's a redelivery of an update already claimed — skip ALL side
 * effects and just acknowledge.
 *
 * Documented tradeoff (brief §11's "no crash window with no recovery
 * path"): every durable action a command performs (createCollectionRun's
 * idempotent slot_key, applyTierTransition, upsertHashtag, ...) is itself
 * a single, fast, idempotent repository write — the gap between claiming
 * the update and that write completing is milliseconds, not a long-running
 * operation. If the process crashes inside that gap, the update stays
 * marked processed and Telegram's own redelivery is correctly suppressed
 * (never a duplicate side effect on retry) — but if the durable write
 * itself never happened, no automatic retry recovers it. That specific
 * outcome (a crash in a multi-millisecond window) is judged acceptably
 * rare for a private single-operator bot; the safe alternative is always
 * available: the operator re-sends the same command manually, which is
 * safe because every underlying repository write here is independently
 * idempotent regardless of Telegram-level dedup.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { telegramUpdates } from "@/db/schema.ts";

export async function tryClaimUpdate(db: Database, updateId: number, receivedAt: Date): Promise<boolean> {
  const rows = await db.insert(telegramUpdates).values({ updateId, receivedAt }).onConflictDoNothing({ target: telegramUpdates.updateId }).returning({ updateId: telegramUpdates.updateId });
  return rows.length > 0;
}

export async function wasUpdateClaimed(db: Database, updateId: number): Promise<boolean> {
  const rows = await db.select({ updateId: telegramUpdates.updateId }).from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)).limit(1);
  return rows.length > 0;
}
