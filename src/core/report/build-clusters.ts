/**
 * Deterministic hashtag clusters (Phase 7 brief §30-31, plan §17): a
 * small report-level projection over Phase 6's persisted co-occurrence
 * edges — Phase 6 never built cluster output itself, only the edges, so
 * this is new but reuses existing data, not new lifecycle analytics.
 * Connected components via union-find over edges meeting a minimum
 * viral-post support and Jaccard similarity; labelled by the strongest
 * tag in the component.
 */
export interface ClusterEdge {
  tagAId: number;
  tagAName: string;
  tagBId: number;
  tagBName: string;
  posts: number;
  viralPosts: number;
  viewsSum: number | null;
}

export interface ClusterConfig {
  max: number;
  minViralPosts: number;
  minJaccard: number;
  maxTagsPerCluster: number;
}

export interface BuiltCluster {
  label: string;
  tags: string[];
  qualifiedPosts: number;
  viewsSum: number | null;
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  private root(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let current = x;
    while (this.parent.get(current) !== current) {
      const next = this.parent.get(current)!;
      this.parent.set(current, this.parent.get(next)!);
      current = next;
    }
    return current;
  }

  union(a: number, b: number): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  find(x: number): number {
    return this.root(x);
  }
}

/**
 * `tagTotalPosts` is each tag's own total post count (over the same
 * window the edges were aggregated for) — the Jaccard denominator.
 * `tagStrength` ranks tags for cluster labelling/top-tag ordering (e.g.
 * qualified-post count or viral views); ties fall back to the higher
 * hashtag id for determinism.
 */
export function buildClusters(edges: ClusterEdge[], tagTotalPosts: Map<number, number>, tagStrength: Map<number, number>, config: ClusterConfig): BuiltCluster[] {
  const eligible = edges
    .filter((e) => e.viralPosts >= config.minViralPosts)
    .map((e) => {
      const nA = tagTotalPosts.get(e.tagAId) ?? e.posts;
      const nB = tagTotalPosts.get(e.tagBId) ?? e.posts;
      const union = nA + nB - e.posts;
      const jaccard = union > 0 ? e.posts / union : 0;
      return { ...e, jaccard };
    })
    .filter((e) => e.jaccard >= config.minJaccard);

  const uf = new UnionFind();
  const nameById = new Map<number, string>();
  for (const e of eligible) {
    uf.union(e.tagAId, e.tagBId);
    nameById.set(e.tagAId, e.tagAName);
    nameById.set(e.tagBId, e.tagBName);
  }

  const groups = new Map<number, Set<number>>();
  for (const id of nameById.keys()) {
    const root = uf.find(id);
    const set = groups.get(root);
    if (set) set.add(id);
    else groups.set(root, new Set([id]));
  }

  const strengthOf = (id: number): number => tagStrength.get(id) ?? 0;
  const cmpByStrength = (a: number, b: number): number => (strengthOf(b) !== strengthOf(a) ? strengthOf(b) - strengthOf(a) : b - a);

  const clusters: BuiltCluster[] = [];
  for (const idSet of groups.values()) {
    if (idSet.size < 2) continue; // a "cluster" needs at least 2 connected tags
    const ids = [...idSet].sort(cmpByStrength);
    const label = nameById.get(ids[0]!)!;
    const memberEdges = eligible.filter((e) => idSet.has(e.tagAId) && idSet.has(e.tagBId));
    const qualifiedPosts = memberEdges.reduce((sum, e) => sum + e.viralPosts, 0);
    const viewsSumRaw = memberEdges.reduce((sum, e) => sum + (e.viewsSum ?? 0), 0);
    clusters.push({
      label,
      tags: ids.slice(0, config.maxTagsPerCluster).map((id) => nameById.get(id)!),
      qualifiedPosts,
      viewsSum: viewsSumRaw > 0 ? viewsSumRaw : null,
    });
  }

  return clusters.sort((a, b) => b.qualifiedPosts - a.qualifiedPosts).slice(0, config.max);
}
