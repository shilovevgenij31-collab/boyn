import type { Category } from "@/core/domain/category";

/**
 * Seed hashtags used to bootstrap hashtag discovery (from Phase 5 onward).
 * This is data, not logic — tracking-tier lifecycle (promotion/demotion
 * between CORE/ACTIVE/EXPLORATION/DORMANT) is implemented in
 * core/lifecycle in Phase 6 and consumes this list; it isn't defined here.
 *
 * English-first for the "global" market (see docs/IMPLEMENTATION_PLAN.md
 * ADR-020). Additional markets/languages extend this list later without a
 * schema change.
 */
export interface SeedHashtag {
  tag: string;
  categories: Category[];
}

export const SEED_HASHTAGS: SeedHashtag[] = [
  // Cosplay
  { tag: "cosplay", categories: ["cosplay"] },
  { tag: "cosplayer", categories: ["cosplay"] },
  { tag: "cosplaygirl", categories: ["cosplay"] },
  { tag: "cosplayvideo", categories: ["cosplay"] },
  { tag: "animecosplay", categories: ["cosplay"] },
  { tag: "gamingcosplay", categories: ["cosplay", "gaming"] },

  // Streaming
  { tag: "streamer", categories: ["streaming"] },
  { tag: "streaming", categories: ["streaming"] },
  { tag: "twitch", categories: ["streaming"] },
  { tag: "twitchstreamer", categories: ["streaming"] },

  // Gaming (general)
  { tag: "gaming", categories: ["gaming"] },
  { tag: "gamer", categories: ["gaming"] },
  { tag: "videogames", categories: ["gaming"] },
  { tag: "gameplay", categories: ["gaming"] },
  { tag: "gamingcommunity", categories: ["gaming"] },

  // PC gaming
  { tag: "pcgaming", categories: ["pc"] },
  { tag: "pcgamer", categories: ["pc"] },
  { tag: "gamingpc", categories: ["pc"] },
  { tag: "pcbuild", categories: ["pc"] },
  { tag: "steam", categories: ["pc"] },

  // PlayStation
  { tag: "playstation", categories: ["playstation"] },
  { tag: "ps5", categories: ["playstation"] },
  { tag: "playstation5", categories: ["playstation"] },
  { tag: "ps5games", categories: ["playstation"] },
  { tag: "psgaming", categories: ["playstation"] },
];
