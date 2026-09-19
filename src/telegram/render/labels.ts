/**
 * Shared Russian labels for domain enums shown in Telegram UI (Phase 8/9
 * production hotfix §6-7) — one place instead of the trend-state
 * emoji/label pair previously duplicated separately in card.ts and
 * tags.ts. Platform names (TikTok/Instagram) are deliberately NOT
 * translated (brief §8).
 */
import type { TrendState } from "@/core/domain/tracking.ts";
import type { Platform } from "@/core/domain/platform.ts";

export const PLATFORM_LABEL: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram" };

export const TREND_STATE_EMOJI: Record<TrendState, string> = {
  BREAKOUT: "🚀",
  RISING: "📈",
  ACTIVE: "🔥",
  STABLE: "➖",
  FALLING: "📉",
  DEAD: "💀",
  NEW: "🆕",
};

/** BREAKOUT -> «прорыв», RISING -> «растёт», ACTIVE -> «активный»,
 * STABLE -> «стабильный», FALLING -> «снижается», DEAD -> «затих»,
 * NEW -> «новый» — one consistent mapping used everywhere a trend state
 * is shown to the user. */
export const TREND_STATE_LABEL_RU: Record<TrendState, string> = {
  BREAKOUT: "прорыв",
  RISING: "растёт",
  ACTIVE: "активный",
  STABLE: "стабильный",
  FALLING: "снижается",
  DEAD: "затих",
  NEW: "новый",
};
