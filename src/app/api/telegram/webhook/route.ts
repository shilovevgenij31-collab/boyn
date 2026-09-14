import { NextResponse, after } from "next/server";
import { getEnv } from "@/config/env.ts";
import { getDb } from "@/db/client.ts";
import { buildTelegramContext } from "@/telegram/build-context.ts";
import { checkWebhookAuth } from "@/telegram/webhook-auth.ts";
import { parseTelegramUpdate } from "@/telegram/update-schema.ts";
import { tryClaimUpdate } from "@/db/repositories/telegram-updates.ts";
import { routeUpdate } from "@/telegram/router.ts";
import { logger } from "@/lib/logger.ts";

// Never cached, never statically optimized (Phase 8 brief §9/§12) — every
// invocation must re-check auth and process a fresh update.
export const dynamic = "force-dynamic";

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

  try {
    const db = getDb();
    // Claim BEFORE any command side effect runs (brief §11) — a
    // redelivery of an already-claimed update_id is a pure no-op here.
    const claimed = await tryClaimUpdate(db, parsed.update.update_id, new Date());
    if (!claimed) {
      return NextResponse.json({ ok: true });
    }

    const ctx = buildTelegramContext(db, env);
    // Respond to Telegram immediately; the actual command work (which may
    // send several messages/pages) runs after the response is flushed
    // (brief §12) — errors inside are caught and logged, never thrown
    // into a response that's already been sent.
    const runInBackground = (): void => {
      routeUpdate(ctx, parsed.update).catch((error: unknown) => {
        logger.error("telegram webhook background processing failed", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    try {
      after(runInBackground);
    } catch {
      // after() requires Next's request-scoped context, which doesn't
      // exist when this handler is invoked directly (e.g. a test calling
      // POST() as a plain function — brief §12's "direct deterministic
      // router execution"). Same fire-and-forget semantics either way.
      runInBackground();
    }
  } catch (error) {
    logger.error("telegram webhook failed", { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
