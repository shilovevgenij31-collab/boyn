/**
 * `/why <rank>` — ADMIN ONLY (Phase 8 brief §49, §84). `<rank>` refers to
 * the rank shown on a card in the latest frozen DailyReport (Today Top,
 * then Still Hot, then Rising Now, in that lookup order — the same
 * numbering `/ideas`'s "representative posts" and every card's `#N`
 * already use). Structured Phase 6 score components only — no LLM
 * explanation (brief §49).
 */
import type { TelegramCommandContext } from "../context.ts";
import type { ReportItem } from "@/core/report/types.ts";
import type { ComponentDetail } from "@/core/analytics/scoring.ts";
import { getLatestDailyReport } from "@/db/repositories/reports.ts";
import { escapeHtml } from "../render/escape.ts";
import { formatVph } from "../render/format.ts";

export const USAGE = "Usage: /why <rank>";
export const NO_REPORT_MESSAGE = "No daily report has been generated yet. Try again after the next scheduled run.";

const COMPONENT_LABEL: Record<ComponentDetail["component"], string> = {
  velocity: "Velocity",
  reach: "Reach",
  engagement: "Engagement",
  freshness: "Freshness",
  hashtagMomentum: "Hashtag momentum",
  acceleration: "Acceleration",
};

function renderComponent(c: ComponentDetail): string {
  if (!c.available || c.raw === null) {
    return `${COMPONENT_LABEL[c.component]}: unavailable`;
  }
  const weight = c.weightUsed !== null ? c.weightUsed.toFixed(2) : "0.00";
  const normalized = c.normalized !== null ? c.normalized.toFixed(2) : "n/a";
  return `${COMPONENT_LABEL[c.component]}: raw ${c.raw.toFixed(2)} · normalized ${normalized} · weight ${weight}`;
}

function findByRank(report: NonNullable<Awaited<ReturnType<typeof getLatestDailyReport>>>, rank: number): { item: ReportItem; section: string } | null {
  for (const [section, items] of [
    ["Today", report.todayTop],
    ["Still Hot", report.stillHot],
    ["Rising Now", report.risingNow],
  ] as const) {
    const item = items.find((i) => i.rank === rank);
    if (item) return { item, section };
  }
  return null;
}

export async function handleWhy(ctx: TelegramCommandContext, chatId: number, args: string): Promise<void> {
  const rank = Number(args.trim());
  if (!Number.isInteger(rank) || rank < 1) {
    await ctx.client.sendMessage({ chat_id: chatId, text: USAGE });
    return;
  }

  const report = await getLatestDailyReport(ctx.db, ctx.market);
  if (!report) {
    await ctx.client.sendMessage({ chat_id: chatId, text: NO_REPORT_MESSAGE });
    return;
  }

  const found = findByRank(report, rank);
  if (!found) {
    await ctx.client.sendMessage({ chat_id: chatId, text: `No post at rank #${rank} in Today/Still Hot/Rising Now.` });
    return;
  }
  const { item, section } = found;

  const lines: string[] = [];
  lines.push(`<b>#${item.rank} · ${escapeHtml(section)}</b>`);
  lines.push(`TrendScore <b>${item.trendScore ?? "unavailable"}</b> · RisingScore <b>${item.risingScore ?? "unavailable"}</b>`);
  lines.push(`VPH: ${formatVph(item.vph, item.vphKind, item.velocityConfidence)}`);
  lines.push("");

  if (!item.scoreComponents) {
    lines.push("Score components unavailable for this item.");
  } else {
    lines.push("<b>TrendScore components</b>");
    for (const c of item.scoreComponents.trend) lines.push(renderComponent(c));
    lines.push("");
    lines.push("<b>RisingScore components</b>");
    for (const c of item.scoreComponents.rising) lines.push(renderComponent(c));
  }

  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true });
}
