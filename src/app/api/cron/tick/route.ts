import { NextResponse } from "next/server";
import { getEnv } from "@/config/env.ts";
import { getDb } from "@/db/client.ts";
import { buildTickContext } from "@/jobs/build-context.ts";
import { runTick } from "@/jobs/tick.ts";
import { logger } from "@/lib/logger.ts";
import { checkCronAuth } from "./auth.ts";

// Never cached, never statically optimized — this must run fresh work
// every invocation (Phase 5 brief §40).
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const auth = checkCronAuth(request.headers.get("authorization"), env.CRON_SECRET);
  if (!auth.ok) {
    logger.warn("cron tick auth rejected", { status: auth.status });
    return NextResponse.json({ ok: false, error: auth.reason }, { status: auth.status });
  }

  try {
    const db = getDb();
    const ctx = buildTickContext(db, env);
    const result = await runTick(ctx);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    logger.error("cron tick failed", { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ok: false, error: "tick failed" }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
