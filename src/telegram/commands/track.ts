/**
 * `/track` — ADMIN ONLY (Phase 8 brief §53-54). `platform` is required and
 * explicit (`tiktok` | `instagram` | `both`) rather than guessed, since
 * `tracked_hashtags` is uniquely keyed on (hashtag, platform, market) and
 * silently picking one would be ambiguous (brief §53's own guidance).
 *
 * Syntax: `/track <tiktok|instagram|both> <#tag> [exploration|active|core]`
 * Tier defaults to EXPLORATION when omitted — ACTIVE/CORE require the
 * admin to type them explicitly (brief §54).
 */
import type { TelegramCommandContext } from "../context.ts";
import type { Platform } from "@/core/domain/platform.ts";
import { PLATFORMS } from "@/core/domain/platform.ts";
import type { TrackingTier } from "@/core/domain/tracking.ts";
import { normalizeHashtagToken } from "@/core/normalize/hashtags.ts";
import { getHashtagByName, upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { applyTierTransition } from "@/db/repositories/analytics-hashtags.ts";
import { escapeHtml } from "../render/escape.ts";

export const USAGE = "Usage: /track <tiktok|instagram|both> <#tag> [exploration|active|core]";

const TIER_ALIASES: Record<string, TrackingTier> = { exploration: "EXPLORATION", active: "ACTIVE", core: "CORE" };

function parsePlatforms(token: string): Platform[] | null {
  const lower = token.toLowerCase();
  if (lower === "both") return [...PLATFORMS];
  if (lower === "tiktok" || lower === "instagram") return [lower];
  return null;
}

export async function handleTrack(ctx: TelegramCommandContext, chatId: number, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    await ctx.client.sendMessage({ chat_id: chatId, text: USAGE });
    return;
  }

  const platforms = parsePlatforms(parts[0]!);
  if (!platforms) {
    await ctx.client.sendMessage({ chat_id: chatId, text: USAGE });
    return;
  }

  const normalized = normalizeHashtagToken(parts[1]!);
  if (!normalized) {
    await ctx.client.sendMessage({ chat_id: chatId, text: `Not a valid hashtag: ${escapeHtml(parts[1]!)}` });
    return;
  }

  let tier: TrackingTier = "EXPLORATION";
  if (parts[2]) {
    const requested = TIER_ALIASES[parts[2].toLowerCase()];
    if (!requested) {
      await ctx.client.sendMessage({ chat_id: chatId, text: `Unknown tier "${escapeHtml(parts[2])}". Use exploration, active, or core.` });
      return;
    }
    tier = requested;
  }

  const now = ctx.clock.now();
  const existingHashtag = await getHashtagByName(ctx.db, normalized);
  if (existingHashtag?.isBlocked) {
    await ctx.client.sendMessage({ chat_id: chatId, text: `#${escapeHtml(normalized)} is blocked and cannot be tracked.` });
    return;
  }

  const hashtagId = await upsertHashtag(ctx.db, normalized, now);
  const lines: string[] = [];
  for (const platform of platforms) {
    const result = await ensureTrackedHashtag(ctx.db, { hashtagId, platform, market: ctx.market, tier, source: "MANUAL" });
    if (result.created) {
      await applyTierTransition(ctx.db, { trackedHashtagId: result.id, fromTier: null, toTier: tier, reason: "MANUAL_ADMIN", at: now });
      lines.push(`${platform}: now tracking #${escapeHtml(normalized)} at ${tier}`);
    } else {
      lines.push(`${platform}: already tracked`);
    }
  }
  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n") });
}
