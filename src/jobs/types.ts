/**
 * Shared types for the Phase 5 tick orchestration (src/jobs/*). This
 * layer is intentionally NOT in src/core — it wires together the DB,
 * provider registry, circuit breaker, clock, and deadline, none of which
 * core/** is allowed to import (CLAUDE.md rule 2).
 */
import type { Database } from "@/db/client.ts";
import type { Clock } from "@/lib/clock.ts";
import type { Deadline } from "@/lib/deadline.ts";
import type { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import type { ProviderRegistry } from "@/providers/registry.ts";
import type { Market } from "@/core/domain/market.ts";
import type { BudgetProfileName } from "@/config/budget.ts";
import type {
  HashtagSource,
  TrackingTier,
  TrendState,
} from "@/core/scheduling/tag-selector.ts";

export interface TickContext {
  db: Database;
  providers: ProviderRegistry;
  circuitBreaker: CircuitBreaker;
  clock: Clock;
  deadline: Deadline;
  market: Market;
  budgetProfile: BudgetProfileName;
}

/** One entry in a discovery job's persisted `input.queries` — a superset
 * of the provider-facing `DiscoveryQuery` shape (query + hashtagId): the
 * extra fields are internal bookkeeping (which tracked_hashtags row to
 * advance on successful ingestion) that never reach a provider adapter. */
export interface DiscoveryJobQueryInput {
  query: string;
  hashtagId: number;
  trackedHashtagId: number;
  tier: TrackingTier;
  source: HashtagSource;
  trendState: TrendState;
}

export interface DiscoveryJobPersistedInput {
  queries: DiscoveryJobQueryInput[];
  limitPerQuery: number;
}

export interface RefreshJobPostInput {
  postId: number;
  externalId: string;
  canonicalUrl: string;
}

export interface RefreshJobPersistedInput {
  posts: RefreshJobPostInput[];
}

export type PartialReason =
  | "PROVIDER_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "DEADLINE"
  | "PARTIAL_PROVIDER_FAILURE"
  | "QUARANTINED_ITEMS"
  | "COLLECTION_PAUSED";

export interface TickResult {
  startedAt: string;
  finishedAt: string;
  planned: { discoveryRuns: number; refreshRuns: number; jobsPlanned: number };
  submitted: number;
  polled: number;
  ingested: number;
  failed: number;
  skipped: number;
  budget: { usedToday: number; usedThisMonth: number; monthlyUsdExceeded: boolean };
  partialReasons: PartialReason[];
}
