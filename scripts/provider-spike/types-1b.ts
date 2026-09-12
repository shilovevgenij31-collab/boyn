import type { FreshnessStats } from "./freshness.ts";
import type { FieldCoverage } from "./coverage.ts";
import type { RelevanceResult } from "./relevance.ts";
import type {
  AsyncLatencyFinding,
  CostFinding,
  IdFinding,
  ProviderName,
  SupportVerdict,
  UrlFinding,
} from "./types.ts";

export type Phase1BOutcome = "TESTED" | "BLOCKED" | "ERROR";

export interface SmokeTestResult {
  attempted: boolean;
  ok: boolean;
  note: string;
}

export interface Phase1BCandidateResult {
  label: string;
  provider: ProviderName;
  outcome: Phase1BOutcome;
  blockedReason: string | null;
  errorMessage: string | null;
  smokeTest: SmokeTestResult | null;
  queryTermsUsed: string[];
  recordsDelivered: number;
  freshness: FreshnessStats | null;
  fieldCoverage: FieldCoverage[];
  viewsMetricNote: string | null;
  relevance: RelevanceResult | null;
  duplicateIdCount: number;
  urlFinding: UrlFinding | null;
  idFinding: IdFinding | null;
  multiQueryAttribution: SupportVerdict;
  multiQueryNote: string;
  asyncLatency: AsyncLatencyFinding | null;
  cost: CostFinding | null;
  fixturesSaved: number;
  edgeCaseNotes: string[];
}

export interface Phase1BResults {
  executedAt: string;
  queryTerms: string[];
  resultsPerQuery: number;
  candidates: Phase1BCandidateResult[];
}
