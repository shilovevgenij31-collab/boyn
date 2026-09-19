/**
 * `/refresh` — ADMIN ONLY (Phase 8 brief §50-52). "Refresh" means an
 * out-of-schedule DISCOVERY request (`collection_runs.kind = "MANUAL"`),
 * never a direct-post refresh and never an Instagram post-URL refresh
 * (that production capability doesn't exist — brief §52). Reuses the
 * exact same durable planning primitives jobs/plan-discovery.ts uses
 * (createCollectionRun, getDueTrackedHashtagsByTier,
 * selectHashtagsForDiscovery, planProviderJob) — this handler never talks
 * to a provider directly (brief §51); the actual HTTP submission happens
 * on the next scheduled tick, same as any other planned job.
 */
import type { TelegramCommandContext } from "../context.ts";
import { PLATFORMS, type Platform } from "@/core/domain/platform.ts";
import { selectHashtagsForDiscovery } from "@/core/scheduling/tag-selector.ts";
import { DISCOVERY_BATCH_SIZE_PER_JOB, DISCOVERY_SLOT_ALLOCATION, POSTS_PER_DISCOVERY_QUERY } from "@/config/schedule.ts";
import { REFRESH_COOLDOWN_MINUTES } from "@/config/telegram.ts";
import { createCollectionRun, finalizeCollectionRun, startCollectionRun } from "@/db/repositories/runs.ts";
import { getDueTrackedHashtagsByTier } from "@/db/repositories/tracking.ts";
import { planProviderJob } from "@/db/repositories/provider-jobs.ts";
import { getSetting, setSetting, isCollectionPaused } from "@/db/repositories/settings.ts";
import { getBudgetStatus, canSubmitToProvider } from "@/providers/budget.ts";
import { isProviderError } from "@/providers/errors.ts";
import { isProviderId } from "@/core/domain/provider.ts";
import type { DiscoveryJobPersistedInput } from "@/jobs/types.ts";
import { escapeHtml } from "../render/escape.ts";

const HEADROOM = 3;

function cooldownKey(platform: Platform): string {
  return `telegram_refresh_cooldown:${platform}`;
}

async function checkAndSetCooldown(ctx: TelegramCommandContext, platform: Platform, now: Date): Promise<boolean> {
  const last = await getSetting<string>(ctx.db, cooldownKey(platform));
  if (last) {
    const elapsedMinutes = (now.getTime() - new Date(last).getTime()) / 60_000;
    if (elapsedMinutes < REFRESH_COOLDOWN_MINUTES) return false;
  }
  await setSetting(ctx.db, cooldownKey(platform), now.toISOString(), now);
  return true;
}

type RefreshOutcome = "accepted" | "cooldown" | "budget_exhausted" | "provider_unavailable" | "collection_paused" | "nothing_due";

async function planManualDiscovery(ctx: TelegramCommandContext, platform: Platform, now: Date): Promise<RefreshOutcome> {
  if (await isCollectionPaused(ctx.db)) return "collection_paused";
  if (!(await checkAndSetCooldown(ctx, platform, now))) return "cooldown";

  const perTier = Math.ceil(DISCOVERY_BATCH_SIZE_PER_JOB / 2) + HEADROOM;
  const [core, active, explorationOrDormant] = await Promise.all([
    getDueTrackedHashtagsByTier(ctx.db, platform, ctx.market, ["CORE"], now, DISCOVERY_SLOT_ALLOCATION.core + HEADROOM),
    getDueTrackedHashtagsByTier(ctx.db, platform, ctx.market, ["ACTIVE"], now, DISCOVERY_SLOT_ALLOCATION.active + HEADROOM),
    getDueTrackedHashtagsByTier(ctx.db, platform, ctx.market, ["EXPLORATION", "DORMANT"], now, DISCOVERY_SLOT_ALLOCATION.explorationOrDormant + perTier),
  ]);
  const selected = selectHashtagsForDiscovery({ core, active, explorationOrDormant }, DISCOVERY_BATCH_SIZE_PER_JOB);
  if (selected.length === 0) return "nothing_due";

  const slotKey = `manual:${platform}:${ctx.market}:${now.toISOString()}`;
  const run = await createCollectionRun(ctx.db, { kind: "MANUAL", slotKey, plannedAt: now, triggeredBy: "telegram:admin" });

  let provider;
  try {
    provider = await ctx.providers.resolveAvailable(platform, "DISCOVERY", ctx.circuitBreaker);
  } catch (error) {
    if (isProviderError(error)) {
      await finalizeCollectionRun(ctx.db, run.id, { status: "SKIPPED", now, recordsUsed: 0, errorSummary: error.message });
      return "provider_unavailable";
    }
    throw error;
  }
  if (!isProviderId(provider.id)) throw new Error(`refresh: resolved a non-persistable provider id "${provider.id}"`);

  const budgetStatus = await getBudgetStatus(ctx.db, now, ctx.budgetProfile);
  if (!canSubmitToProvider(budgetStatus, provider.id)) {
    await finalizeCollectionRun(ctx.db, run.id, { status: "SKIPPED", now, recordsUsed: 0, errorSummary: "budget exhausted at planning time" });
    return "budget_exhausted";
  }

  const input: DiscoveryJobPersistedInput = {
    queries: selected.map((c) => ({ query: c.hashtagName, hashtagId: c.hashtagId, trackedHashtagId: c.trackedHashtagId, tier: c.tier, source: c.source, trendState: c.trendState })),
    limitPerQuery: POSTS_PER_DISCOVERY_QUERY,
  };
  await planProviderJob(ctx.db, { collectionRunId: run.id, provider: provider.id, platform, jobType: "HASHTAG_DISCOVERY", input: input as unknown as Record<string, unknown> });
  await startCollectionRun(ctx.db, run.id, now);
  return "accepted";
}

const OUTCOME_TEXT: Record<RefreshOutcome, string> = {
  accepted: "внеплановый сбор поставлен в очередь, запустится на следующем тике",
  cooldown: `повторный запуск пока недоступен (не чаще раза в ${REFRESH_COOLDOWN_MINUTES} мин)`,
  budget_exhausted: "автоматический бюджет на этот месяц исчерпан; новый платный сбор не запущен",
  provider_unavailable: "провайдер временно недоступен (сработал circuit breaker)",
  collection_paused: "сбор данных сейчас на паузе",
  nothing_due: "сейчас нет хэштегов, которые пора сканировать",
};

export async function handleRefresh(ctx: TelegramCommandContext, chatId: number, args: string): Promise<void> {
  const now = ctx.clock.now();
  const arg = args.trim().toLowerCase();
  const platforms: Platform[] = arg === "tiktok" || arg === "instagram" ? [arg] : arg === "" ? [...PLATFORMS] : [];

  if (platforms.length === 0) {
    await ctx.client.sendMessage({ chat_id: chatId, text: "Использование: /refresh, /refresh tiktok или /refresh instagram" });
    return;
  }

  const lines: string[] = [];
  for (const platform of platforms) {
    const outcome = await planManualDiscovery(ctx, platform, now);
    lines.push(`${platform}: ${escapeHtml(OUTCOME_TEXT[outcome])}`);
  }
  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n") });
}
