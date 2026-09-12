export const CATEGORIES = ["cosplay", "streaming", "gaming", "pc", "playstation"] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Category roll-up relationships (e.g. `/gaming` includes `pc` and
 * `playstation` posts). This is a fixed domain fact, not a tunable — the
 * tunable seed hashtag list lives in config/taxonomy.ts.
 */
export const CATEGORY_PARENTS: Partial<Record<Category, Category>> = {
  pc: "gaming",
  playstation: "gaming",
};
