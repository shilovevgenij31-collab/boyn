/**
 * `/tags` (Phase 8 brief §42) — persisted Phase 6/7 hashtag radar data
 * only, no reclassification. Wording stays "Radar momentum"/"Observed"
 * throughout (render/tags.ts), never a platform-wide growth claim.
 */
import type { TelegramCommandContext } from "../context.ts";
import { getClusterEdges, getHashtagSections } from "@/db/repositories/report-data.ts";
import { renderTagsSection } from "../render/tags.ts";
import { enforceMessageLimit } from "../render/page.ts";

const SECTION_LIMIT = 5;

export async function handleTags(ctx: TelegramCommandContext, chatId: number): Promise<void> {
  const now = ctx.clock.now();
  const dateStr = now.toISOString().slice(0, 10);
  const clusterEdges = await getClusterEdges(ctx.db, ctx.market, dateStr);
  const sections = await getHashtagSections(ctx.db, ctx.market, now, clusterEdges);

  const text = [
    "<b>Динамика хэштегов внутри Trend Radar</b> (наша наблюдаемая выборка, не платформа целиком)",
    renderTagsSection("🚀 Прорывные", sections.breakout.slice(0, SECTION_LIMIT)),
    renderTagsSection("📈 Растущие", sections.rising.slice(0, SECTION_LIMIT)),
    renderTagsSection("🏷 Топ по числу качественных постов", sections.topByQualifiedPosts.slice(0, SECTION_LIMIT)),
  ].join("\n\n");

  await ctx.client.sendMessage({ chat_id: chatId, text: enforceMessageLimit(text), parse_mode: "HTML", disable_web_page_preview: true });
}
