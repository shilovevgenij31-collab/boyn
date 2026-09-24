import { NextResponse } from "next/server";
import { getEnv } from "@/config/env.ts";
import { getDb } from "@/db/client.ts";
import { buildDailyContext } from "@/jobs/build-daily-context.ts";
import { runDaily } from "@/jobs/run-daily.ts";
import { logger } from "@/lib/logger.ts";
import { checkCronAuth } from "../tick/auth.ts";

// Never cached, never statically optimized (Phase 7 brief §53, same
// discipline as the tick route). maxDuration gives this route real
// headroom for per-post/per-hashtag analytics work, still comfortably
// under Vercel Hobby's 300s hard kill — see config/schedule.ts's
// DEFAULT_DAILY_DEADLINE_MS, which bounds the internal analytics stage
// well below this.
export const dynamic = "force-dynamic";
export const maxDuration = 280;

async function handle(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const auth = checkCronAuth(request.headers.get("authorization"), env.CRON_SECRET);
  if (!auth.ok) {
    logger.warn("cron daily auth rejected", { status: auth.status });
    return NextResponse.json({ ok: false, error: auth.reason }, { status: auth.status });
  }

  try {
    const db = getDb();
    const ctx = await buildDailyContext(db, env);
    const result = await runDaily(ctx);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    logger.error("cron daily failed", { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ok: false, error: "daily job failed" }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
