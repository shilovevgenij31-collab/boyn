/**
 * Deterministic multi-label post category classification (Phase 6 brief
 * §41-43, plan §18 step 4): the union of a post's tags' own categories
 * (confidence >= 0.5), the discovery query's category (if known), and
 * caption keyword rules — same regex rules classify-hashtag.ts applies
 * to tag names, applied here to caption text.
 */
import type { Category } from "@/core/domain/category.ts";
import { classifyHashtagByKeyword } from "./classify-hashtag.ts";

export type PostCategorySource = "TAG" | "QUERY" | "KEYWORD";

export interface PostCategoryEvidence {
  category: Category;
  confidence: number;
  source: PostCategorySource;
}

export interface ClassifyPostInput {
  /** The post's own hashtags' already-resolved best category, from
   * hashtag_categories — only entries with confidence >= 0.5 count
   * (brief §43's confidence hierarchy). */
  hashtagCategories: { category: Category; confidence: number }[];
  /** The category of whichever tracked-hashtag query discovered this
   * post, if the job knows it (brief §43: "discovery query category:
   * medium/high"). */
  queryCategory?: Category | null;
  caption?: string | null;
}

const TAG_EVIDENCE_MIN_CONFIDENCE = 0.5;
const QUERY_EVIDENCE_CONFIDENCE = 0.8;

export function classifyPost(input: ClassifyPostInput): PostCategoryEvidence[] {
  const byCategory = new Map<Category, PostCategoryEvidence>();
  const consider = (category: Category, confidence: number, source: PostCategorySource): void => {
    const existing = byCategory.get(category);
    if (!existing || confidence > existing.confidence) byCategory.set(category, { category, confidence, source });
  };

  for (const hc of input.hashtagCategories) {
    if (hc.confidence >= TAG_EVIDENCE_MIN_CONFIDENCE) consider(hc.category, hc.confidence, "TAG");
  }
  if (input.queryCategory) consider(input.queryCategory, QUERY_EVIDENCE_CONFIDENCE, "QUERY");
  if (input.caption) {
    for (const evidence of classifyHashtagByKeyword(input.caption)) {
      consider(evidence.category, evidence.confidence, "KEYWORD");
    }
  }
  return [...byCategory.values()];
}
