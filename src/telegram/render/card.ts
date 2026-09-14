/**
 * One compact ranked-post card (Phase 8 brief §24-30). Every field comes
 * straight from a frozen `ReportItem` — no reclassification, no
 * re-querying `posts` (brief §71). Null provider metrics are omitted,
 * never shown as `0` (CLAUDE.md rule 8 / brief §24).
 */
import type { ReportItem } from "@/core/report/types.ts";
import { escapeHtml, truncateUnicode } from "./escape.ts";
import { formatAge, formatCompactNumber, formatVph } from "./format.ts";

const TREND_STATE_EMOJI: Partial<Record<string, string>> = {
  BREAKOUT: "🚀",
  RISING: "📈",
  ACTIVE: "🔥",
  STABLE: "➖",
  FALLING: "📉",
  DEAD: "💀",
  NEW: "🆕",
};

const PLATFORM_LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram" };

/** Brief §28: <=120 visible characters, Unicode-safe. */
const CAPTION_PREVIEW_MAX_CHARS = 120;
/** Brief §29: a bounded set, not dozens of tags. */
const MAX_HASHTAGS_SHOWN = 5;

function engagementRatioPct(item: ReportItem): number | null {
  if (item.views === null || item.views === 0) return null;
  if (item.likes === null && item.comments === null && item.shares === null) return null;
  const engagement = (item.likes ?? 0) + (item.comments ?? 0) + (item.shares ?? 0);
  return (engagement / item.views) * 100;
}

/** `position` is the 1-based slot on the CURRENT page (1-5), matching the
 * numbered URL button above it — not necessarily `item.rank` when a page
 * shows items 6-10 etc; callers pass the page-local index. */
export function renderCard(item: ReportItem, position: number): string {
  const lines: string[] = [];

  const stateEmoji = item.trendState ? (TREND_STATE_EMOJI[item.trendState] ?? "") : "";
  const stateLabel = item.trendState ? `${stateEmoji} ${item.trendState}`.trim() : "";
  const headline = [`<b>#${position} · ${PLATFORM_LABEL[item.platform] ?? item.platform}</b>`, stateLabel].filter((s) => s.length > 0).join(" · ");
  lines.push(`🔥 ${headline}`);

  const metricsParts: string[] = [];
  if (item.views !== null) metricsParts.push(`<b>${formatCompactNumber(item.views)}</b> views`);
  metricsParts.push(`<b>${formatVph(item.vph, item.vphKind, item.velocityConfidence)}</b>`);
  if (item.ageHours !== null) metricsParts.push(`${formatAge(item.ageHours)} old`);
  if (metricsParts.length > 0) lines.push(metricsParts.join(" · "));

  const scoreParts: string[] = [];
  if (item.trendScore !== null) scoreParts.push(`Score <b>${item.trendScore}</b>`);
  const er = engagementRatioPct(item);
  if (er !== null) scoreParts.push(`ER ${er.toFixed(1)}%`);
  if (item.comments !== null) scoreParts.push(`💬 ${formatCompactNumber(item.comments)}`);
  if (item.shares !== null) scoreParts.push(`🔁 ${formatCompactNumber(item.shares)}`);
  if (scoreParts.length > 0) lines.push(scoreParts.join(" · "));

  const identityParts: string[] = [];
  if (item.creatorUsername) identityParts.push(`@${escapeHtml(item.creatorUsername)}`);
  if (item.categories.length > 0) identityParts.push(escapeHtml(item.categories.join(", ")));
  if (identityParts.length > 0) lines.push(identityParts.join(" · "));

  const tags = item.hashtags.slice(0, MAX_HASHTAGS_SHOWN);
  if (tags.length > 0) lines.push(tags.map((t) => `#${escapeHtml(t)}`).join(" "));

  if (item.captionPreview) {
    const { text, truncated } = truncateUnicode(item.captionPreview, CAPTION_PREVIEW_MAX_CHARS);
    lines.push(`<i>${escapeHtml(text)}${truncated ? "…" : ""}</i>`);
  }

  return lines.join("\n");
}
