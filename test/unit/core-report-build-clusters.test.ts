import { describe, expect, it } from "vitest";
import { buildClusters, type ClusterEdge } from "@/core/report/build-clusters.ts";

const CONFIG = { max: 10, minViralPosts: 2, minJaccard: 0.15, maxTagsPerCluster: 8 };

describe("buildClusters", () => {
  it("connects tags with strong co-occurrence into one cluster", () => {
    const edges: ClusterEdge[] = [
      { tagAId: 1, tagAName: "arcane", tagBId: 2, tagBName: "jinx", posts: 8, viralPosts: 4, viewsSum: 500_000 },
      { tagAId: 2, tagAName: "jinx", tagBId: 3, tagBName: "jinxcosplay", posts: 6, viralPosts: 3, viewsSum: 300_000 },
    ];
    const tagTotalPosts = new Map([[1, 10], [2, 10], [3, 8]]);
    const tagStrength = new Map([[1, 4], [2, 7], [3, 3]]);

    const clusters = buildClusters(edges, tagTotalPosts, tagStrength, CONFIG);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.label).toBe("jinx"); // highest strength
    expect(clusters[0]?.tags).toEqual(expect.arrayContaining(["arcane", "jinx", "jinxcosplay"]));
  });

  it("excludes edges below the minimum viral-post support", () => {
    const edges: ClusterEdge[] = [{ tagAId: 1, tagAName: "a", tagBId: 2, tagBName: "b", posts: 5, viralPosts: 1, viewsSum: null }];
    const clusters = buildClusters(edges, new Map([[1, 10], [2, 10]]), new Map(), CONFIG);
    expect(clusters).toHaveLength(0);
  });

  it("excludes edges below the minimum Jaccard similarity", () => {
    // posts=1 out of totals 100+100-1=199 -> jaccard ~0.005, far below 0.15
    const edges: ClusterEdge[] = [{ tagAId: 1, tagAName: "a", tagBId: 2, tagBName: "b", posts: 1, viralPosts: 5, viewsSum: null }];
    const clusters = buildClusters(edges, new Map([[1, 100], [2, 100]]), new Map(), CONFIG);
    expect(clusters).toHaveLength(0);
  });

  it("a single tag with no qualifying edges never forms a cluster (needs >=2 connected tags)", () => {
    const clusters = buildClusters([], new Map(), new Map(), CONFIG);
    expect(clusters).toHaveLength(0);
  });

  it("caps the number of tags shown per cluster", () => {
    const edges: ClusterEdge[] = [];
    const tagTotalPosts = new Map<number, number>();
    const tagStrength = new Map<number, number>();
    // a chain of 12 tags, each pair strongly co-occurring
    for (let i = 0; i < 12; i++) {
      tagTotalPosts.set(i, 10);
      tagStrength.set(i, 12 - i);
    }
    for (let i = 0; i < 11; i++) {
      edges.push({ tagAId: i, tagAName: `t${i}`, tagBId: i + 1, tagBName: `t${i + 1}`, posts: 8, viralPosts: 3, viewsSum: null });
    }
    const clusters = buildClusters(edges, tagTotalPosts, tagStrength, CONFIG);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.tags.length).toBeLessThanOrEqual(CONFIG.maxTagsPerCluster);
  });

  it("is capped at the configured maximum number of clusters, sorted by qualified posts", () => {
    const edges: ClusterEdge[] = [];
    const tagTotalPosts = new Map<number, number>();
    for (let i = 0; i < 30; i += 2) {
      tagTotalPosts.set(i, 10);
      tagTotalPosts.set(i + 1, 10);
      edges.push({ tagAId: i, tagAName: `t${i}`, tagBId: i + 1, tagBName: `t${i + 1}`, posts: 8, viralPosts: 2 + i, viewsSum: null });
    }
    const clusters = buildClusters(edges, tagTotalPosts, new Map(), { ...CONFIG, max: 3 });
    expect(clusters).toHaveLength(3);
    // sorted descending by qualifiedPosts
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i]!.qualifiedPosts).toBeLessThanOrEqual(clusters[i - 1]!.qualifiedPosts);
    }
  });
});
