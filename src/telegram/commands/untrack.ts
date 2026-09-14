/**
 * `/untrack` — ADMIN ONLY (Phase 8 brief §55-56). Never deletes historical
 * hashtag data — moves the tracked tag to DORMANT (the existing "not
 * actively scanned" lifecycle state) and writes a MANUAL_ADMIN tier
 * event, same audit convention `/track` uses.
 *
 * Syntax: `/untrack <tiktok|instagram|both> <#tag>`
 */
import type { TelegramCommandContext } from "../context.ts";
import type { Platform } from "@/core/domain/platform.ts";
import { PLATFORMS } from "@/core/domain/platform.ts";
import { normalizeHashtagToken } from "@/core/normalize/hashtags.ts";
import { getHashtagByName } from "@/db/repositories/hashtags.ts";
import { getTrackedHashtag } from "@/db/repositories/tracking.ts";
import { applyTierTransition } from "@/db/repositories/analytics-hashtags.ts";
import { escapeHtml } from "../render/escape.ts";

export const USAGE = "Usage: /untrack <tiktok|instagram|both> <#tag>";

function parsePlatforms(token: string): Platform[] | null {
  const lower = token.toLowerCase();
  if (lower === "both") return [...PLATFORMS];
  if (lower === "tiktok" || lower === "instagram") return [lower];
  return null;
}

export async function handleUntrack(ctx: TelegramCommandContext, chatId: number, args: string): Promise<void> {
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

  const hashtag = await getHashtagByName(ctx.db, normalized);
  if (!hashtag) {
    await ctx.client.sendMessage({ chat_id: chatId, text: `#${escapeHtml(normalized)} is not tracked anywhere.` });
    return;
  }

  const now = ctx.clock.now();
  const lines: string[] = [];
  for (const platform of platforms) {
    const tracked = await getTrackedHashtag(ctx.db, hashtag.id, platform, ctx.market);
    if (!tracked) {
      lines.push(`${platform}: not tracked`);
      continue;
    }
    if (tracked.tier === "DORMANT") {
      lines.push(`${platform}: already DORMANT`);
      continue;
    }
    // CORE only ever auto-transitions never (core/lifecycle/hashtag-
    // lifecycle.ts) — but a deliberate ADMIN /untrack is exactly the
    // "human decision" that module's own doc comment reserves for CORE,
    // so it's allowed here.
    await applyTierTransition(ctx.db, { trackedHashtagId: tracked.id, fromTier: tracked.tier, toTier: "DORMANT", reason: "MANUAL_ADMIN", at: now });
    lines.push(`${platform}: moved to DORMANT`);
  }
  await ctx.client.sendMessage({ chat_id: chatId, text: lines.join("\n") });
}
