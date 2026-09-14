/**
 * `/rising` (Phase 8 brief §36-37) — deliberately NOT the frozen daily
 * report's `risingNow` section: a fresh `result_view` computed from
 * CURRENT Phase 6 analytics at command time, using the same RisingScore
 * ranking and rankable-pool rule the daily report uses.
 */
import type { TelegramCommandContext } from "../context.ts";
import { buildLiveView } from "../live-views.ts";
import { createResultView } from "@/db/repositories/result-views.ts";
import { RESULT_VIEW_TTL_DAYS } from "@/config/telegram.ts";
import { sendPaginatedView } from "./shared.ts";
import { escapeHtml } from "../render/escape.ts";

export async function handleRising(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const now = ctx.clock.now();
  const items = await buildLiveView(ctx.db, ctx.market, now, { mode: "rising" });
  const asOf = now.toISOString().slice(11, 16);
  const header = `📈 <b>Rising Now</b>\nData as of ${escapeHtml(asOf)} UTC — current analytics, not the daily snapshot.`;
  const viewId = await createResultView(ctx.db, { kind: "rising", headerText: header, extra: { mode: "rising" }, items, createdAt: now, ttlDays: RESULT_VIEW_TTL_DAYS });
  await sendPaginatedView(ctx, chatId, viewId, items, header);
}
