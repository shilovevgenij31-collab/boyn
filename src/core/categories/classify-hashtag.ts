/**
 * Deterministic multi-label hashtag category classification (Phase 6
 * brief §41-44, plan §18). No AI, no external hashtag search — every
 * signal here is either the committed taxonomy seed list or a fixed
 * regex rule. A hashtag can carry more than one category (e.g.
 * "pcgaming" -> pc AND gaming, matching CATEGORY_PARENTS's roll-up).
 */
import type { Category } from "@/core/domain/category.ts";
import { SEED_HASHTAGS } from "@/config/taxonomy.ts";

export type HashtagCategorySource = "SEED" | "KEYWORD" | "COOCCURRENCE";

export interface HashtagCategoryEvidence {
  category: Category;
  confidence: number;
  source: HashtagCategorySource;
}

const KEYWORD_CONFIDENCE = 0.9;

/** Plan §18 step 2's exact rules — order doesn't matter, a tag can match
 * more than one. */
const KEYWORD_RULES: { pattern: RegExp; category: Category }[] = [
  { pattern: /cosplay/i, category: "cosplay" },
  { pattern: /stream|twitch|kick|live/i, category: "streaming" },
  { pattern: /ps5|playstation|psn|dualsense/i, category: "playstation" },
  { pattern: /pc(gaming|gamer|build|setup|master)|steam|rtx|nvidia|gamingpc/i, category: "pc" },
  { pattern: /gam(e|er|ing)|gameplay|videogame/i, category: "gaming" },
];

/** Step 1: seed mapping from config/taxonomy.ts, confidence 1.0. Returns
 * [] for any tag not in the committed seed list (most discovered tags). */
export function classifyHashtagBySeed(tagName: string): HashtagCategoryEvidence[] {
  const seed = SEED_HASHTAGS.find((s) => s.tag === tagName);
  if (!seed) return [];
  return seed.categories.map((category) => ({ category, confidence: 1.0, source: "SEED" as const }));
}

/** Step 2: keyword rules on the tag name itself, confidence 0.9. Applied
 * regardless of whether a seed match already exists (a tag can gain
 * additional categories this way — the caller merges/dedupes). */
export function classifyHashtagByKeyword(text: string): HashtagCategoryEvidence[] {
  const matches: HashtagCategoryEvidence[] = [];
  const seen = new Set<Category>();
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text) && !seen.has(rule.category)) {
      matches.push({ category: rule.category, confidence: KEYWORD_CONFIDENCE, source: "KEYWORD" });
      seen.add(rule.category);
    }
  }
  return matches;
}

/**
 * Step 3: co-occurrence inference for an otherwise-unknown tag (plan
 * §18): for each category, the share of the tag's own posts that also
 * carry a hashtag of that category. Assigned only with >= 5 posts total
 * (brief §44: "do not infer a category from one weak accidental
 * co-occurrence") and a share >= 0.4; confidence = the share itself.
 */
export function classifyHashtagFromCooccurrence(totalPosts: number, categoryShares: Partial<Record<Category, number>>): HashtagCategoryEvidence[] {
  if (totalPosts < 5) return [];
  const out: HashtagCategoryEvidence[] = [];
  for (const [category, share] of Object.entries(categoryShares) as [Category, number][]) {
    if (share >= 0.4) out.push({ category, confidence: share, source: "COOCCURRENCE" });
  }
  return out;
}

/** Merges evidence from all three steps, keeping the highest confidence
 * per category (a SEED match at 1.0 always wins over a KEYWORD match at
 * 0.9 for the same category, but a category unique to one step is kept). */
export function mergeHashtagCategoryEvidence(...evidenceLists: HashtagCategoryEvidence[][]): HashtagCategoryEvidence[] {
  const byCategory = new Map<Category, HashtagCategoryEvidence>();
  for (const list of evidenceLists) {
    for (const evidence of list) {
      const existing = byCategory.get(evidence.category);
      if (!existing || evidence.confidence > existing.confidence) byCategory.set(evidence.category, evidence);
    }
  }
  return [...byCategory.values()];
}
