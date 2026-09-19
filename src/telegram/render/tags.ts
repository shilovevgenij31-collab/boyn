/**
 * `/tags` hashtag lines (Phase 8 brief §42; Russian localization — Phase
 * 8/9 hotfix §7, §15). Wording always makes clear this is Trend Radar's
 * own monitored sample, never a platform-wide claim (CLAUDE.md rule 13):
 * "Momentum в нашей выборке" / "наблюдаемых постов", never "TikTok вырос
 * на X%". All data comes straight from a persisted `TagItem` (Phase 7
 * output) — no reclassification here.
 */
import type { TagItem } from "@/core/report/types.ts";
import { escapeHtml } from "./escape.ts";
import { PLATFORM_LABEL, TREND_STATE_EMOJI, TREND_STATE_LABEL_RU } from "./labels.ts";

export function renderTagLine(tag: TagItem): string {
  const emoji = TREND_STATE_EMOJI[tag.trendState];
  const header = `#${escapeHtml(tag.tag)} · ${PLATFORM_LABEL[tag.platform] ?? tag.platform} · ${emoji} ${TREND_STATE_LABEL_RU[tag.trendState]}`.trim();
  const momentum = tag.radarMomentum !== null ? tag.radarMomentum.toFixed(2) : "нет данных";
  const stats = `Momentum в нашей выборке: ${momentum} · наблюдаемых постов за 24 ч: ${tag.radarPosts24h} (качественных: ${tag.qualifiedPosts24h})`;
  const related = tag.relatedTags.length > 0 ? `\nСвязанные теги: ${tag.relatedTags.map((t) => `#${escapeHtml(t)}`).join(" ")}` : "";
  return `${header}\n${stats}${related}`;
}

export function renderTagsSection(title: string, tags: TagItem[]): string {
  if (tags.length === 0) return `<b>${escapeHtml(title)}</b>\n(пока пусто)`;
  return [`<b>${escapeHtml(title)}</b>`, ...tags.map((t) => renderTagLine(t))].join("\n\n");
}
