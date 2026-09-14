/**
 * Platform and category filter commands (Phase 8 brief §38-41): `/tiktok`,
 * `/instagram`, `/cosplay`, `/streamers`, `/gaming`, `/pc`, `/playstation`.
 * All share one live-view builder (`buildLiveView`) — recent (<=72h)
 * rankable posts, ranked by current TrendScore with deterministic tie-
 * breakers, never raw views (brief §41).
 */
import type { TelegramCommandContext } from "../context.ts";
import type { Platform } from "@/core/domain/platform.ts";
import type { Category } from "@/core/domain/category.ts";
import { buildLiveView } from "../live-views.ts";
import { createResultView } from "@/db/repositories/result-views.ts";
import { RESULT_VIEW_TTL_DAYS } from "@/config/telegram.ts";
import { sendPaginatedView } from "./shared.ts";

const PLATFORM_LABEL: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram" };
const CATEGORY_LABEL: Record<Category, string> = { cosplay: "Cosplay", streaming: "Streamers", gaming: "Gaming", pc: "PC Gaming", playstation: "PlayStation" };

export async function handlePlatformFilter(ctx: TelegramCommandContext, chatId: number, platform: Platform): Promise<void> {
  const now = ctx.clock.now();
  const items = await buildLiveView(ctx.db, ctx.market, now, { mode: "trend", platform });
  const header = `<b>${PLATFORM_LABEL[platform]}</b> · recent, ranked by TrendScore`;
  const viewId = await createResultView(ctx.db, { kind: platform, headerText: header, extra: { platform }, items, createdAt: now, ttlDays: RESULT_VIEW_TTL_DAYS });
  await sendPaginatedView(ctx, chatId, viewId, items, header);
}

export async function handleCategoryFilter(ctx: TelegramCommandContext, chatId: number, category: Category): Promise<void> {
  const now = ctx.clock.now();
  const items = await buildLiveView(ctx.db, ctx.market, now, { mode: "trend", category });
  const header = `<b>${CATEGORY_LABEL[category]}</b> · recent, ranked by TrendScore`;
  const viewId = await createResultView(ctx.db, { kind: category, headerText: header, extra: { category }, items, createdAt: now, ttlDays: RESULT_VIEW_TTL_DAYS });
  await sendPaginatedView(ctx, chatId, viewId, items, header);
}
