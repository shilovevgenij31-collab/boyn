/**
 * Provider webhook endpoint (Phase 5 brief §43-45) — a pure optimization.
 * The system stays correct with polling alone if this is never called.
 * Verification is the per-job unguessable webhook_token (never a claimed
 * external_job_id/status from the body, which is never even parsed here)
 * — on a match, this only brings the job's next_poll_at forward to now,
 * so the next tick re-derives real status from the provider's own status
 * API rather than trusting anything the request claims.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/db/client.ts";
import { getJobByWebhookToken, nudgeJobPollNow } from "@/db/repositories/provider-jobs.ts";
import { isProviderId } from "@/core/domain/provider.ts";
import { systemClock } from "@/lib/clock.ts";
import { logger } from "@/lib/logger.ts";

export const dynamic = "force-dynamic";

async function handle(request: Request, provider: string): Promise<NextResponse> {
  if (!isProviderId(provider)) {
    return NextResponse.json({ ok: false, error: "unknown provider" }, { status: 404 });
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 401 });
  }

  const db = getDb();
  const job = await getJobByWebhookToken(db, provider, token);
  if (!job) {
    // Same response whether the token is wrong or unknown — never reveal
    // which.
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const nudged = await nudgeJobPollNow(db, job.id, systemClock.now());
  logger.info("webhook nudged job poll", { jobId: String(job.id), provider, nudged: String(nudged) });
  return NextResponse.json({ ok: true, nudged });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider } = await context.params;
  return handle(request, provider);
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider } = await context.params;
  return handle(request, provider);
}
