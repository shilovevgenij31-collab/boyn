/**
 * The one generic "missing component -> drop it, renormalize the rest"
 * helper (Phase 6 brief §14 — mandatory, generic, heavily tested). Used
 * both for combining V/R/E/F/H/A into TrendScore/RisingScore and for
 * combining like/comment/share ratios into the engagement component
 * itself — the exact same rule applies at both levels.
 */
export interface WeightedComponent {
  key: string;
  /** `null` means "unavailable", never a fabricated 0 (CLAUDE.md rule 8). */
  value: number | null;
  weight: number;
}

export interface CombinedResult {
  /** Weighted sum of the available components, using renormalized
   * weights (they sum to 1 across whatever was available). */
  value: number;
  /** The renormalized weight actually used for each AVAILABLE component
   * — for explainScore (brief §25/§63). */
  weightsUsed: Record<string, number>;
}

/**
 * Filters out components with `value === null` or `weight <= 0`,
 * renormalizes the remaining weights to sum to 1, and returns the
 * weighted sum. Returns `null` if nothing is available at all (never
 * fabricates a 0 result) or if the raw weight assigned to the
 * available components is 0.
 */
export function combineWeighted(components: WeightedComponent[]): CombinedResult | null {
  const available = components.filter((c) => c.value !== null && c.weight > 0);
  const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);
  if (available.length === 0 || totalWeight <= 0) return null;

  const weightsUsed: Record<string, number> = {};
  let value = 0;
  for (const c of available) {
    const w = c.weight / totalWeight;
    weightsUsed[c.key] = w;
    value += w * c.value!;
  }
  return { value, weightsUsed };
}
