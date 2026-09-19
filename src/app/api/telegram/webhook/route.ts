import { NextResponse } from "next/server";
import { getEnv } from "@/config/env.ts";
import { getDb } from "@/db/client.ts";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import { checkWebhookAuth } from "@/telegram/webhook-auth.ts";
import { parseTelegramUpdate } from "@/telegram/update-schema.ts";
import { releaseClaim, tryClaimUpdate } from "@/db/repositories/telegram-updates.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { logger } from "@/lib/logger.ts";

/**
 * PRODUCTION INCIDENT (Phase 8/9 hotfix): the original implementation
 * claimed `update_id` and then scheduled `routeUpdate()` to run via
 * Next's `after()` (falling back to an unawaited fire-and-forget call
 * outside a request scope), returning `{ ok: true }` immediately.
 * Production evidence showed a real `/today` update reaching the point
 * of creating its `result_views` row (i.e. well into the handler) but
 * NEVER sending the Telegram message and NEVER recording an error — the
 * Vercel serverless function was being frozen/torn down after the
 * response flushed, before the deferred work's outbound `fetch` to the
 * Telegram Bot API ever completed. Every command appeared to silently do
 * nothing.
 *
 * Fix: process the update FULLY SYNCHRONOUSLY, awaited, before this
 * handler returns a response at all. This guarantees Vercel keeps the
 * function alive for the whole command (including the Telegram API
 * call) — the small latency cost (our commands complete in well under a
 * second in practice) is strictly preferable to losing replies. See
 * db/repositories/telegram-updates.ts for the matching dedupe fix: a
 * claim is released on failure so a genuine crash doesn't permanently
 * blackhole an update.
 */
export const dynamic = "force-dynamic";
// Comfortably above what any single command needs (`/export` sending 3
// documents is the slowest path) — see config/telegram.ts's own budget
// comments — while staying well under Vercel Hobby's hard limit.
export const maxDuration = 30;

export async function POST(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const auth = checkWebhookAuth(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET);
  if (!auth.ok) {
    logger.warn("telegram webhook auth rejected", { status: auth.status });
    return NextResponse.json({ ok: false }, { status: auth.status });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed JSON" }, { status: 400 });
  }

  const parsed = parseTelegramUpdate(raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: "invalid update" }, { status: 400 });
  }

  const updateId = parsed.update.update_id;
  let db: ReturnType<typeof getDb>;
  let claimed: boolean;
  try {
    db = getDb();
    claimed = await tryClaimUpdate(db, updateId, new Date());
  } catch (error) {
    logger.error("telegram webhook dedupe check failed", { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (!claimed) {
    // Already fully processed (or a rare concurrent redelivery still
    // in-flight) — never re-run side effects.
    return NextResponse.json({ ok: true });
  }

  try {
    const ctx = buildTelegramContext(db, env);
    await routeUpdate(ctx, parsed.update);
  } catch (error) {
    logger.error("telegram webhook processing failed", { message: error instanceof Error ? error.message : String(error) });
    try {
      await releaseClaim(db, updateId);
    } catch (releaseError) {
      logger.error("telegram webhook claim release failed", { message: releaseError instanceof Error ? releaseError.message : String(releaseError) });
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
