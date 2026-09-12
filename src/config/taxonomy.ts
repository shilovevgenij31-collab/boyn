import type { Category } from "@/core/domain/category";

/**
 * Seed hashtags used to bootstrap hashtag discovery (from Phase 5 onward).
 * This is data, not logic — tracking-tier lifecycle *transitions*
 * (promotion/demotion between CORE/ACTIVE/EXPLORATION/DORMANT) are
 * implemented in core/lifecycle in Phase 6 and consume this list; only
 * each seed's *initial* tier is decided here, matching
 * docs/IMPLEMENTATION_PLAN.md §11's LEAN CORE list exactly (Phase 3 uses
 * this to seed src/db/seed.ts — see ADR there for why CORE is a small
 * subset rather than every seed tag).
 *
 * English-first for the "global" market (see docs/IMPLEMENTATION_PLAN.md
 * ADR-020). Additional markets/languages extend this list later without a
 * schema change.
 */
export interface SeedHashtag {
  tag: string;
  categories: Category[];
  /** CORE: always checked, tightest schedule. DORMANT: seeded but
   * low-priority until it earns promotion like any discovered tag (see
   * plan §11) — weekly probes only. No seed starts ACTIVE/EXPLORATION;
   * those states are earned, not assigned. */
  initialTier: "CORE" | "DORMANT";
}

export const SEED_HASHTAGS: SeedHashtag[] = [
  // Cosplay
  { tag: "cosplay", categories: ["cosplay"], initialTier: "CORE" },
  { tag: "cosplayer", categories: ["cosplay"], initialTier: "CORE" },
  { tag: "cosplaygirl", categories: ["cosplay"], initialTier: "DORMANT" },
  { tag: "cosplayvideo", categories: ["cosplay"], initialTier: "DORMANT" },
  { tag: "animecosplay", categories: ["cosplay"], initialTier: "DORMANT" },
  { tag: "gamingcosplay", categories: ["cosplay", "gaming"], initialTier: "DORMANT" },

  // Streaming
  { tag: "streamer", categories: ["streaming"], initialTier: "CORE" },
  { tag: "streaming", categories: ["streaming"], initialTier: "DORMANT" },
  { tag: "twitch", categories: ["streaming"], initialTier: "DORMANT" },
  { tag: "twitchstreamer", categories: ["streaming"], initialTier: "CORE" },

  // Gaming (general)
  { tag: "gaming", categories: ["gaming"], initialTier: "CORE" },
  { tag: "gamer", categories: ["gaming"], initialTier: "DORMANT" },
  { tag: "videogames", categories: ["gaming"], initialTier: "DORMANT" },
  { tag: "gameplay", categories: ["gaming"], initialTier: "DORMANT" },
  { tag: "gamingcommunity", categories: ["gaming"], initialTier: "DORMANT" },

  // PC gaming
  { tag: "pcgaming", categories: ["pc"], initialTier: "CORE" },
  { tag: "pcgamer", categories: ["pc"], initialTier: "DORMANT" },
  { tag: "gamingpc", categories: ["pc"], initialTier: "DORMANT" },
  { tag: "pcbuild", categories: ["pc"], initialTier: "DORMANT" },
  { tag: "steam", categories: ["pc"], initialTier: "DORMANT" },

  // PlayStation
  { tag: "playstation", categories: ["playstation"], initialTier: "CORE" },
  { tag: "ps5", categories: ["playstation"], initialTier: "CORE" },
  { tag: "playstation5", categories: ["playstation"], initialTier: "DORMANT" },
  { tag: "ps5games", categories: ["playstation"], initialTier: "DORMANT" },
  { tag: "psgaming", categories: ["playstation"], initialTier: "DORMANT" },
];
