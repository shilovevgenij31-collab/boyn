import type { FreshnessStats } from "./freshness.ts";
import type { FieldCoverage } from "./coverage.ts";

export type ProviderName = "brightdata" | "apify";
export type PlatformName = "tiktok" | "instagram";

export type CombinationKey = `${ProviderName}_${PlatformName}`;

export type CombinationOutcome = "TESTED" | "BLOCKED" | "ERROR";

export interface UrlFinding {
  sampleField: string | null;
  looksCanonical: boolean;
  hostSeen: string | null;
  example: string | null;
  note: string;
}

export interface IdFinding {
  candidateField: string | null;
  stable: boolean | "UNKNOWN";
  note: string;
}

export type SupportVerdict = "SUPPORTED" | "PARTIAL" | "NOT_SUPPORTED" | "AMBIGUOUS" | "NOT_TESTED";

export interface RefreshByUrlFinding {
  verdict: SupportVerdict;
  originalExternalId: string | null;
  refreshedExternalId: string | null;
  sameExternalId: boolean | null;
  originalViews: number | null;
  refreshedViews: number | null;
  latencyMs: number | null;
  note: string;
}

export interface AsyncLatencyFinding {
  submittedAt: number | null;
  readyAt: number | null;
  totalLatencyMs: number | null;
  pollCount: number | null;
  finalStatus: string | null;
}

export interface CostFinding {
  recordsRequested: number;
  recordsDelivered: number;
  providerReportedUsage: string | null;
  estimatedUsd: number | null;
  estimateBasis: string;
}

export interface CombinationResult {
  provider: ProviderName;
  platform: PlatformName;
  outcome: CombinationOutcome;
  blockedReason: string | null;
  errorMessage: string | null;
  hashtagsQueried: string[];
  recordsDelivered: number;
  freshness: FreshnessStats | null;
  fieldCoverage: FieldCoverage[];
  viewsMetricNote: string | null;
  urlFinding: UrlFinding | null;
  idFinding: IdFinding | null;
  multiQueryAttribution: SupportVerdict;
  multiQueryNote: string;
  asyncLatency: AsyncLatencyFinding | null;
  refreshByUrl: RefreshByUrlFinding | null;
  edgeCaseNotes: string[];
  cost: CostFinding | null;
  fixturesSaved: number;
}

export interface SpikeResults {
  executedAt: string;
  hashtagsUsed: string[];
  resultsPerHashtag: number;
  combinations: CombinationResult[];
}
