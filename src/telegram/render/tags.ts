/**
 * `/tags` hashtag lines (Phase 8 brief §42) — wording is always "Radar
 * momentum" / "Observed in monitored sample", never a platform-wide claim
 * (CLAUDE.md rule 13). All data comes straight from a persisted `TagItem`
 * (Phase 7 output) — no reclassification here.
 */
import type { TagItem } from "@/core/report/types.ts";
import { escapeHtml } from "./escape.ts";

const PLATFORM_LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram" };
const TREND_STATE_EMOJI: Partial<Record<string, string>> = { BREAKOUT: "🚀", RISING: "📈", ACTIVE: "🔥", STABLE: "➖", FALLING: "📉", DEAD: "💀", NEW: "🆕" };

export function renderTagLine(tag: TagItem): string {
  const emoji = TREND_STATE_EMOJI[tag.trendState] ?? "";
  const header = `#${escapeHtml(tag.tag)} · ${PLATFORM_LABEL[tag.platform] ?? tag.platform} · ${emoji} ${tag.trendState}`.trim();
  const momentum = tag.radarMomentum !== null ? tag.radarMomentum.toFixed(2) : "unavailable";
  const stats = `Radar momentum ${momentum} · Observed ${tag.radarPosts24h} posts (${tag.qualifiedPosts24h} qualified)`;
  const related = tag.relatedTags.length > 0 ? `\nRelated: ${tag.relatedTags.map((t) => `#${escapeHtml(t)}`).join(" ")}` : "";
  return `${header}\n${stats}${related}`;
}

export function renderTagsSection(title: string, tags: TagItem[]): string {
  if (tags.length === 0) return `<b>${escapeHtml(title)}</b>\n(none)`;
  return [`<b>${escapeHtml(title)}</b>`, ...tags.map((t) => renderTagLine(t))].join("\n\n");
}
