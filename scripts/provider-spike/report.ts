import type { CombinationResult, SpikeResults } from "./types.ts";
import { buildAllRecommendations, type PlatformRecommendation } from "./recommendation.ts";

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${n}%`;
}
function fmtHours(n: number | null): string {
  return n === null ? "—" : `${n}h`;
}
function fmtBool(b: boolean | "UNKNOWN" | null): string {
  if (b === "UNKNOWN" || b === null) return "UNKNOWN";
  return b ? "yes" : "no";
}

function combinationLabel(c: CombinationResult): string {
  return `${c.provider} / ${c.platform}`;
}

function freshnessRow(c: CombinationResult): string {
  const f = c.freshness;
  if (!f) return `| ${combinationLabel(c)} | ${c.outcome} | — | — | — | — | — | — | — |`;
  return (
    `| ${combinationLabel(c)} | ${f.sampleSize} | ${f.withTimestamp} | ` +
    `${fmtHours(f.medianAgeHours)} | ${fmtPct(f.pctLt6h)} | ${fmtPct(f.pctLt12h)} | ` +
    `${fmtPct(f.pctLt24h)} | ${fmtPct(f.pctLt48h)} | ${fmtPct(f.pctLt72h)} |`
  );
}

function coverageSection(c: CombinationResult): string {
  if (c.fieldCoverage.length === 0) return "_not tested_";
  const lines = [
    "| Field | Present | Total | Coverage |",
    "|---|---|---|---|",
    ...c.fieldCoverage.map((f) => `| \`${f.field}\` | ${f.present} | ${f.total} | ${f.pct}% |`),
  ];
  return lines.join("\n");
}

function outcomeBadge(c: CombinationResult): string {
  if (c.outcome === "TESTED") return "✅ TESTED";
  if (c.outcome === "BLOCKED") return `⛔ BLOCKED — ${c.blockedReason ?? "unknown reason"}`;
  return `❌ ERROR — ${c.errorMessage ?? "unknown error"}`;
}

function combinationSection(c: CombinationResult): string {
  const parts: string[] = [];
  parts.push(`### ${combinationLabel(c)}`);
  parts.push("");
  parts.push(`**Status:** ${outcomeBadge(c)}`);
  parts.push("");

  if (c.outcome !== "TESTED") {
    return parts.join("\n");
  }

  parts.push(`**Hashtags queried:** ${c.hashtagsQueried.map((h) => `#${h}`).join(", ")}`);
  parts.push(`**Records delivered:** ${c.recordsDelivered}`);
  parts.push("");

  parts.push("**Field coverage:**");
  parts.push("");
  parts.push(coverageSection(c));
  parts.push("");

  parts.push(`**Views metric:** ${c.viewsMetricNote ?? "not recorded"}`);
  parts.push("");

  if (c.urlFinding) {
    parts.push(
      `**Canonical URL:** field=\`${c.urlFinding.sampleField ?? "—"}\`, looks canonical: ` +
        `${fmtBool(c.urlFinding.looksCanonical)}, host: ${c.urlFinding.hostSeen ?? "—"}. ` +
        c.urlFinding.note,
    );
    if (c.urlFinding.example) parts.push(`  Example: \`${c.urlFinding.example}\``);
    parts.push("");
  }

  if (c.idFinding) {
    parts.push(
      `**Stable ID:** field=\`${c.idFinding.candidateField ?? "—"}\`, stable: ` +
        `${fmtBool(c.idFinding.stable)}. ${c.idFinding.note}`,
    );
    parts.push("");
  }

  parts.push(`**Multi-query attribution:** ${c.multiQueryAttribution} — ${c.multiQueryNote}`);
  parts.push("");

  if (c.asyncLatency) {
    parts.push(
      `**Async latency:** ${c.asyncLatency.totalLatencyMs ?? "—"}ms total, ` +
        `${c.asyncLatency.pollCount ?? "—"} poll(s), final status \`${c.asyncLatency.finalStatus ?? "—"}\`.`,
    );
    parts.push("");
  }

  if (c.refreshByUrl) {
    const r = c.refreshByUrl;
    parts.push(
      `**Refresh-by-URL:** ${r.verdict} — sameExternalId: ${fmtBool(r.sameExternalId)}, ` +
        `views ${r.originalViews ?? "—"} → ${r.refreshedViews ?? "—"}, latency ${r.latencyMs ?? "—"}ms. ${r.note}`,
    );
    parts.push("");
  }

  if (c.edgeCaseNotes.length > 0) {
    parts.push("**Edge cases observed:**");
    for (const note of c.edgeCaseNotes) parts.push(`- ${note}`);
    parts.push("");
  }

  if (c.cost) {
    parts.push(
      `**Cost:** requested ${c.cost.recordsRequested}, delivered ${c.cost.recordsDelivered}, ` +
        `provider-reported usage: ${c.cost.providerReportedUsage ?? "not exposed"}, ` +
        `estimate: ${c.cost.estimatedUsd !== null ? `$${c.cost.estimatedUsd.toFixed(2)}` : "n/a"} ` +
        `(${c.cost.estimateBasis}).`,
    );
    parts.push("");
  }

  parts.push(`**Fixtures saved:** ${c.fixturesSaved}`);

  return parts.join("\n");
}

const GATE_BADGE: Record<PlatformRecommendation["gate"], string> = {
  PASSED: "✅ PASSED",
  FAILED: "❌ FAILED",
  BLOCKED: "⛔ BLOCKED",
};

function decisionMatrixRow(c: CombinationResult): string {
  const f = c.freshness;
  const cell = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
  return (
    `| ${c.provider} / ${c.platform} | ${c.outcome} | ${cell(f?.pctLt24h)}% | ` +
    `${c.urlFinding ? fmtBool(c.urlFinding.looksCanonical) : "—"} | ` +
    `${c.idFinding ? cell(c.idFinding.candidateField) : "—"} | ` +
    `${c.viewsMetricNote ? "yes" : "—"} | ${c.refreshByUrl?.verdict ?? "—"} | ` +
    `${c.asyncLatency?.totalLatencyMs ?? "—"}ms | ` +
    `${c.cost?.estimatedUsd !== null && c.cost?.estimatedUsd !== undefined ? `$${c.cost.estimatedUsd.toFixed(2)}` : "—"} |`
  );
}

function recommendationSection(rec: PlatformRecommendation): string {
  const lines: string[] = [];
  lines.push(`### ${rec.platform.toUpperCase()}`);
  lines.push("");
  lines.push(`**Decision gate:** ${GATE_BADGE[rec.gate]} — ${rec.gateReason}`);
  lines.push("");
  lines.push(`**Can we detect content "taking off today"?** ${rec.productFit} — ${rec.productFitReason}`);
  lines.push("");
  lines.push(`- **Primary discovery:** ${rec.primaryDiscovery} — ${rec.primaryDiscoveryReason}`);
  lines.push(`- **Fallback:** ${rec.fallback} — ${rec.fallbackReason}`);
  lines.push(`- **Refresh:** ${rec.refresh} — ${rec.refreshReason}`);
  lines.push("");
  return lines.join("\n");
}

function buildDecisionSection(results: SpikeResults): string {
  const lines: string[] = [];
  lines.push("## Decision matrix");
  lines.push("");
  lines.push(
    "| Combination | Outcome | %<24h | Canonical URL | Stable-ID field | Views metric found | Refresh-by-URL | Latency | Est. cost |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of results.combinations) lines.push(decisionMatrixRow(c));
  lines.push("");

  lines.push("## Routing recommendation & decision gate");
  lines.push("");
  lines.push(
    "Computed from the measurements above (see `scripts/provider-spike/recommendation.ts`): " +
      `GOOD freshness requires %<24h ≥ 40, PARTIAL requires ≥ 15, below that is POOR. ` +
      "A platform's gate PASSES only if at least one tested path is GOOD or PARTIAL.",
  );
  lines.push("");
  for (const rec of buildAllRecommendations(results.combinations)) {
    lines.push(recommendationSection(rec));
  }

  return lines.join("\n");
}

export function buildReportMarkdown(results: SpikeResults): string {
  const lines: string[] = [];
  lines.push("# Provider Spike — Phase 1 Results");
  lines.push("");
  lines.push(
    "This report is generated by `scripts/provider-spike.ts` from real measurements — it is " +
      "not hand-written. Re-running the script regenerates it. See " +
      "`docs/IMPLEMENTATION_PLAN.md` §28 Phase 1 for scope, and `.spike/results.json` " +
      "(gitignored) for the full machine-readable output this was built from.",
  );
  lines.push("");
  lines.push(`**Executed at:** ${results.executedAt}`);
  lines.push(`**Test hashtags:** ${results.hashtagsUsed.map((h) => `#${h}`).join(", ")}`);
  lines.push(`**Target results per hashtag:** up to ${results.resultsPerHashtag}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Freshness summary");
  lines.push("");
  lines.push(
    "| Combination | Sample | With timestamp | Median age | %<6h | %<12h | %<24h | %<48h | %<72h |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of results.combinations) lines.push(freshnessRow(c));
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Per-combination detail");
  lines.push("");
  for (const c of results.combinations) {
    lines.push(combinationSection(c));
    lines.push("");
  }
  lines.push("---");
  lines.push("");

  lines.push(buildDecisionSection(results));
  lines.push("");
  lines.push("---");
  lines.push("");

  const blocked = results.combinations.filter((c) => c.outcome === "BLOCKED");
  const tested = results.combinations.filter((c) => c.outcome === "TESTED");
  const errored = results.combinations.filter((c) => c.outcome === "ERROR");

  lines.push("## Run summary");
  lines.push("");
  lines.push(`- Tested: ${tested.length}/${results.combinations.length}`);
  lines.push(`- Blocked (missing credentials): ${blocked.length}/${results.combinations.length}`);
  lines.push(`- Errored: ${errored.length}/${results.combinations.length}`);
  if (blocked.length > 0) {
    lines.push("");
    lines.push("**Blocked combinations and why:**");
    for (const c of blocked) {
      lines.push(`- ${combinationLabel(c)}: ${c.blockedReason ?? "unknown reason"}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
