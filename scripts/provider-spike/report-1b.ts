import type { Phase1BCandidateResult, Phase1BResults } from "./types-1b.ts";
import { rateFreshness } from "./recommendation.ts";

const START_MARKER = "<!-- PHASE-1B-START (auto-generated, do not edit by hand) -->";
const END_MARKER = "<!-- PHASE-1B-END -->";

function fmt(v: unknown): string {
  return v === null || v === undefined ? "—" : String(v);
}

function candidateSection(c: Phase1BCandidateResult): string {
  const lines: string[] = [];
  lines.push(`### ${c.label}`);
  lines.push("");

  if (c.smokeTest) {
    lines.push(`**Smoke test:** ${c.smokeTest.ok ? "✅ OK" : "❌ FAILED"} — ${c.smokeTest.note}`);
    lines.push("");
  }

  if (c.outcome === "BLOCKED") {
    lines.push(`**Status:** ⛔ BLOCKED — ${c.blockedReason ?? "unknown reason"}`);
    return lines.join("\n");
  }
  if (c.outcome === "ERROR") {
    lines.push(`**Status:** ❌ ERROR — ${c.errorMessage ?? "unknown error"}`);
    return lines.join("\n");
  }

  const f = c.freshness;
  lines.push("**Status:** ✅ TESTED");
  lines.push("");
  lines.push(`**Query terms:** ${c.queryTermsUsed.join(", ")}`);
  lines.push(`**Records delivered:** ${c.recordsDelivered}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Sample / with timestamp | ${fmt(f?.sampleSize)} / ${fmt(f?.withTimestamp)} |`);
  lines.push(`| Median age | ${fmt(f?.medianAgeHours)}h |`);
  lines.push(`| p25 / p75 / p90 age | ${fmt(f?.p25AgeHours)}h / ${fmt(f?.p75AgeHours)}h / ${fmt(f?.p90AgeHours)}h |`);
  lines.push(`| Min / max age | ${fmt(f?.minAgeHours)}h / ${fmt(f?.maxAgeHours)}h |`);
  lines.push(`| %<6h / %<12h / %<24h | ${fmt(f?.pctLt6h)}% / ${fmt(f?.pctLt12h)}% / ${fmt(f?.pctLt24h)}% |`);
  lines.push(`| %<48h / %<72h | ${fmt(f?.pctLt48h)}% / ${fmt(f?.pctLt72h)}% |`);
  lines.push(`| Freshness rating | **${rateFreshness(f)}** |`);
  lines.push(
    `| Relevance (caption/hashtags match query) | ${fmt(c.relevance?.matched)}/${fmt(c.relevance?.total)} (${fmt(c.relevance?.pct)}%) |`,
  );
  lines.push(`| Duplicate IDs in sample | ${c.duplicateIdCount} |`);
  lines.push(`| Views metric | ${fmt(c.viewsMetricNote)} |`);
  lines.push(`| Multi-query attribution | ${c.multiQueryAttribution} |`);
  lines.push(
    `| Async latency | ${fmt(c.asyncLatency?.totalLatencyMs)}ms, ${fmt(c.asyncLatency?.pollCount)} poll(s), status \`${fmt(c.asyncLatency?.finalStatus)}\` |`,
  );
  lines.push(
    `| Est. cost | ${c.cost?.estimatedUsd !== null && c.cost?.estimatedUsd !== undefined ? `$${c.cost.estimatedUsd.toFixed(2)}` : "—"} (${fmt(c.cost?.estimateBasis)}) |`,
  );
  lines.push(`| Fixtures saved | ${c.fixturesSaved} |`);
  lines.push("");

  if (c.urlFinding) {
    lines.push(
      `**Canonical URL:** field=\`${fmt(c.urlFinding.sampleField)}\`, canonical: ${c.urlFinding.looksCanonical ? "yes" : "no"}, host: ${fmt(c.urlFinding.hostSeen)}. Example: \`${fmt(c.urlFinding.example)}\``,
    );
    lines.push("");
  }
  if (c.idFinding) {
    lines.push(`**Stable ID field:** \`${fmt(c.idFinding.candidateField)}\` — ${c.idFinding.note}`);
    lines.push("");
  }
  if (c.relevance && c.relevance.mismatchExamples.length > 0) {
    lines.push("**Irrelevant-result examples:**");
    for (const ex of c.relevance.mismatchExamples) lines.push(`- "${ex}"`);
    lines.push("");
  }
  if (c.edgeCaseNotes.length > 0) {
    lines.push("**Edge cases observed:**");
    for (const note of c.edgeCaseNotes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (c.fieldCoverage.length > 0) {
    lines.push("**Field coverage:**");
    lines.push("");
    lines.push("| Field | Present | Total | Coverage |");
    lines.push("|---|---|---|---|");
    for (const fc of c.fieldCoverage) lines.push(`| \`${fc.field}\` | ${fc.present} | ${fc.total} | ${fc.pct}% |`);
    lines.push("");
  }

  return lines.join("\n");
}

type Verdict = "GOOD" | "PARTIAL" | "POOR" | "UNKNOWN";

function bestCandidate(results: Phase1BResults): { candidate: Phase1BCandidateResult; rating: Verdict } | null {
  const tested = results.candidates.filter((c) => c.outcome === "TESTED");
  if (tested.length === 0) return null;
  const rank: Record<Verdict, number> = { GOOD: 3, PARTIAL: 2, POOR: 1, UNKNOWN: 0 };
  const rated = tested.map((c) => ({ candidate: c, rating: rateFreshness(c.freshness) as Verdict }));
  rated.sort((a, b) => rank[b.rating] - rank[a.rating]);
  return rated[0]!;
}

function decisionSection(results: Phase1BResults): string {
  const lines: string[] = [];
  lines.push("### Routing decision");
  lines.push("");

  const best = bestCandidate(results);
  const tested = results.candidates.filter((c) => c.outcome === "TESTED");
  const untested = results.candidates.filter((c) => c.outcome !== "TESTED");

  if (!best || best.rating === "POOR") {
    lines.push(
      `**TikTok gate: ❌ FAILED.** ${
        tested.length === 0
          ? "Neither candidate could be tested."
          : `Best tested candidate (${best?.candidate.label}) is still dominated by stale content.`
      }`,
    );
    lines.push("");
    lines.push("- **Primary discovery:** NONE");
    lines.push("- **Fallback:** NONE");
    lines.push(
      "- **Refresh:** apify (postURLs, confirmed SUPPORTED in Phase 1 — independent of discovery freshness)",
    );
    return lines.join("\n");
  }

  const other = tested.find((c) => c !== best.candidate);
  const otherRating = other ? rateFreshness(other.freshness) : null;

  lines.push(
    `**TikTok gate: ${best.rating === "GOOD" ? "✅ PASSED" : "🟡 PASSED (partial)"}.** Primary discovery: ` +
      `**${best.candidate.provider}** (${best.candidate.label}) — %<24h=${best.candidate.freshness?.pctLt24h ?? "—"}, ` +
      `median age ${best.candidate.freshness?.medianAgeHours ?? "—"}h, rating ${best.rating}.`,
  );
  lines.push("");
  lines.push(`- **Primary discovery:** ${best.candidate.provider} — ${best.candidate.label}`);
  lines.push(
    `- **Fallback:** ${
      other && otherRating !== "POOR"
        ? `${other.provider} — usable secondary path (rating ${otherRating}, %<24h=${other.freshness?.pctLt24h ?? "—"})`
        : other
          ? `${other.provider} tested but rating ${otherRating} — not a reliable freshness fallback; still useful for broader/non-realtime queries given its field coverage`
          : "none tested"
    }`,
  );
  lines.push(
    "- **Refresh:** apify (postURLs, confirmed SUPPORTED in Phase 1) is primary; Bright Data collect-by-URL " +
      "is a verified-to-exist secondary option but was not re-benchmarked here and observed ~5-6 min " +
      "latency per job in this run's discovery calls, so it is not preferred for time-sensitive refresh.",
  );
  if (untested.length > 0) {
    lines.push("");
    lines.push(`_Untested this run: ${untested.map((c) => `${c.label} (${c.blockedReason})`).join("; ")}_`);
  }
  return lines.join("\n");
}

function comparisonTable(results: Phase1BResults): string {
  const lines: string[] = [];
  lines.push("| Candidate | Outcome | Median age | %<24h | Relevance | Rating |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of results.candidates) {
    lines.push(
      `| ${c.label} | ${c.outcome} | ${fmt(c.freshness?.medianAgeHours)}h | ${fmt(c.freshness?.pctLt24h)}% | ` +
        `${fmt(c.relevance?.pct)}% | ${c.outcome === "TESTED" ? rateFreshness(c.freshness) : "—"} |`,
    );
  }
  return lines.join("\n");
}

export function buildPhase1BSection(results: Phase1BResults): string {
  const lines: string[] = [];
  lines.push(START_MARKER);
  lines.push("");
  lines.push("## Phase 1B — TikTok Discovery Rescue");
  lines.push("");
  lines.push(
    "Narrow follow-up to Phase 1 (see above), generated by `scripts/provider-spike-1b.ts`. Instagram " +
      "was already resolved in Phase 1 (Apify primary, gate PASSED) and is not retested here. Scope: " +
      "find a viable *fresh* TikTok discovery path, since Apify hashtag-mode discovery (Phase 1) was " +
      "rejected for staleness (median age 534.3h, 3.3% <24h).",
  );
  lines.push("");
  lines.push(`**Executed at:** ${results.executedAt}`);
  lines.push(`**Query terms:** ${results.queryTerms.join(", ")}`);
  lines.push(`**Target results per query:** up to ${results.resultsPerQuery}`);
  lines.push("");
  lines.push("### Comparison");
  lines.push("");
  lines.push(comparisonTable(results));
  lines.push("");
  for (const c of results.candidates) {
    lines.push(candidateSection(c));
    lines.push("");
  }
  lines.push(decisionSection(results));
  lines.push("");
  lines.push(END_MARKER);
  return lines.join("\n");
}

/** Inserts (or, on re-run, replaces) the Phase 1B section in an existing
 * report, leaving everything else — the original Phase 1 content —
 * untouched. Appends at the end if no Phase 1B section exists yet. */
export function upsertPhase1BSection(existingMarkdown: string, section: string): string {
  const startIdx = existingMarkdown.indexOf(START_MARKER);
  const endIdx = existingMarkdown.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingMarkdown.slice(0, startIdx);
    const after = existingMarkdown.slice(endIdx + END_MARKER.length);
    return `${before}${section}${after}`;
  }
  const trimmed = existingMarkdown.replace(/\n+$/, "");
  return `${trimmed}\n\n---\n\n${section}\n`;
}
