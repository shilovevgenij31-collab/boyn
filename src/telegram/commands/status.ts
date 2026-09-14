/**
 * `/status` (Phase 8 brief §43-44) — built entirely from persisted
 * application state; no live provider health request (no Apify/Bright
 * Data API call happens here).
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
  return d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "never";
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
  lines.push("<b>Status</b>");
  lines.push(`Scheduler last tick: ${formatTimestamp(lastTick)}`);
  lines.push(`Last TikTok discovery: ${formatTimestamp(activity.lastTiktokDiscovery)}`);
  lines.push(`Last Instagram discovery: ${formatTimestamp(activity.lastInstagramDiscovery)}`);
  lines.push(`Last refresh: ${formatTimestamp(activity.lastRefresh)}`);
  lines.push(`Latest report: ${latestReport ? `${escapeHtml(latestReport.reportDate)} (${latestReport.status})` : "none yet"}`);
  lines.push("");
  lines.push(`<b>Budget</b> (${budget.profile})`);
  lines.push(`Today: ${budget.usedToday} records · Month: $${budget.estimatedUsdMonth.toFixed(2)} / $${(budget.estimatedUsdMonth + budget.remainingMonthlyUsd).toFixed(2)}`);
  lines.push("");
  lines.push(`<b>Providers</b>: ${circuitLines.join(" · ")}`);
  lines.push("");
  lines.push(`<b>Tracked hashtags</b>: CORE ${tierCounts.CORE} · ACTIVE ${tierCounts.ACTIVE} · EXPLORATION ${tierCounts.EXPLORATION} · DORMANT ${tierCounts.DORMANT}`);
  lines.push("");
  lines.push("<b>AI</b>: deterministic only (Phase 8) — no LLM");

  if (isAdminUser) {
    const recentErrors = await getRecentErrorEvents(ctx.db, dayStart, 5);
    lines.push("");
    lines.push(`<b>Errors (24h)</b>: ${recentErrors.length === 0 ? "none" : ""}`);
    for (const err of recentErrors) {
      lines.push(`- [${err.severity}] ${escapeHtml(err.scope)}: ${escapeHtml(err.message.slice(0, 100))}`);
    }
  }

  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true });
}
