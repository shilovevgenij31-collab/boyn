/**
 * `/status` (Phase 8 brief §43-44; Russian localization — Phase 8/9
 * hotfix §11) — built entirely from persisted application state; no live
 * provider health request (no Apify/Bright Data API call happens here).
 */
import type { TelegramCommandContext } from "../context.ts";
import { getMostRecentCollectionRunPlannedAt } from "@/db/repositories/runs.ts";
import { getLatestCollectionActivity, getRecentErrorEvents, getTrackedTierCounts } from "@/db/repositories/telegram-status.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { getBudgetStatus } from "@/providers/budget.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import { DEFAULT_BUDGET_PROFILE } from "@/config/budget.ts";
import { escapeHtml } from "../render/escape.ts";

function formatTimestamp(d: Date | null): string {
  return d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "ещё не было";
}

export async function handleStatus(ctx: TelegramCommandContext, chatId: number, isAdminUser: boolean): Promise<void> {
  const now = ctx.clock.now();
  const dayStart = new Date(now.getTime() - 24 * 3_600_000);

  const [lastTick, activity, tierCounts, budget, latestReport] = await Promise.all([
    getMostRecentCollectionRunPlannedAt(ctx.db),
    getLatestCollectionActivity(ctx.db),
    getTrackedTierCounts(ctx.db, ctx.market),
    getBudgetStatus(ctx.db, now, DEFAULT_BUDGET_PROFILE),
    getLatestDailyReport(ctx.db, ctx.market),
  ]);

  const circuitBreaker = new CircuitBreaker(new DbCircuitBreakerStore(ctx.db));
  const circuitLines: string[] = [];
  for (const platform of ["tiktok", "instagram"] as const) {
    for (const provider of ["apify", "brightdata"] as const) {
      const available = await circuitBreaker.isAvailable({ provider, platform, operation: "DISCOVERY" });
      circuitLines.push(`${platform}/${provider} ${available ? "✅" : "⛔"}`);
    }
  }

  const lines: string[] = [];
  lines.push("<b>Статус</b>");
  lines.push(`Последний tick: ${formatTimestamp(lastTick)}`);
  lines.push(`Последний сбор TikTok: ${formatTimestamp(activity.lastTiktokDiscovery)}`);
  lines.push(`Последний сбор Instagram: ${formatTimestamp(activity.lastInstagramDiscovery)}`);
  lines.push(`Последний refresh: ${formatTimestamp(activity.lastRefresh)}`);
  lines.push(`Последний отчёт: ${latestReport ? `${escapeHtml(latestReport.reportDate)} (${latestReport.status === "PARTIAL" ? "неполный" : "полный"})` : "ещё не было"}`);
  lines.push("");
  lines.push(`<b>Бюджет</b> (${budget.profile})`);
  lines.push(`Сегодня: ${budget.usedToday} записей · за месяц: $${budget.estimatedUsdMonth.toFixed(2)} / $${(budget.estimatedUsdMonth + budget.remainingMonthlyUsd).toFixed(2)}`);
  lines.push("");
  lines.push(`<b>Провайдеры</b>: ${circuitLines.join(" · ")}`);
  lines.push("");
  lines.push(`<b>Отслеживаемые хэштеги</b>: CORE ${tierCounts.CORE} · ACTIVE ${tierCounts.ACTIVE} · EXPLORATION ${tierCounts.EXPLORATION} · DORMANT ${tierCounts.DORMANT}`);
  lines.push("");
  lines.push("<b>AI</b>: пока только детерминированный анализ, без LLM");

  if (isAdminUser) {
    const recentErrors = await getRecentErrorEvents(ctx.db, dayStart, 5);
    lines.push("");
    lines.push(`<b>Ошибки за 24 часа</b>: ${recentErrors.length === 0 ? "нет" : ""}`);
    for (const err of recentErrors) {
      lines.push(`- [${err.severity}] ${escapeHtml(err.scope)}: ${escapeHtml(err.message.slice(0, 100))}`);
    }
  }

  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true });
}
