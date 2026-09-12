/**
 * A fully in-memory, deterministic SocialDataProvider — no network,
 * configurable failure/delay/attribution behavior, for offline tests of
 * anything that consumes the provider interface (registry, circuit
 * breaker, future Phase 5 orchestration). Not a real production origin:
 * "fixture" is deliberately excluded from the DB-persisted ProviderId
 * enum (src/core/domain/provider.ts) — nothing should ever write it to
 * provider_jobs.provider.
 */
import type { Clock } from "@/lib/clock.ts";
import { systemClock } from "@/lib/clock.ts";
import { ProviderError } from "../errors.ts";
import type {
  DiscoveryJobInput,
  ProviderCapabilities,
  ProviderJobState,
  ProviderJobStatus,
  ProviderResultPage,
  RefreshJobInput,
  SocialDataProvider,
  SubmittedProviderJob,
} from "../provider.ts";

export interface FixtureJobPlan {
  /** How many getStatus() calls return RUNNING before flipping to READY
   * (or FAILED, if `failAfter` is reached first). 0 = READY immediately. */
  runningPolls?: number;
  /** If set, getStatus() reports FAILED once this many polls have
   * happened (checked before `runningPolls`'s READY transition). */
  failAfter?: number;
  items: unknown[];
}

export interface FixtureProviderConfig {
  capabilities?: Partial<ProviderCapabilities>;
  /** Queue of plans consumed in order, one per submitDiscovery/submitRefresh
   * call. Running out of planned jobs is a test bug, not silently handled. */
  jobs: FixtureJobPlan[];
  /** Injected so a deterministic offline simulation (Phase 5 brief §38) can
   * run several *simulated* days without `submittedAt` drifting to the
   * real wall clock — defaults to the real clock so Phase 4's existing
   * tests (which never assert on exact timestamps) are unaffected. */
  clock?: Clock;
}

interface FixtureJobState {
  plan: FixtureJobPlan;
  pollCount: number;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  tiktok: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
  instagram: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
};

export class FixtureProvider implements SocialDataProvider {
  readonly id = "fixture" as const;

  private readonly plannedJobs: FixtureJobPlan[];
  private readonly jobs = new Map<string, FixtureJobState>();
  private readonly clock: Clock;
  private nextJobId = 1;

  constructor(private readonly config: FixtureProviderConfig) {
    this.plannedJobs = [...config.jobs];
    this.clock = config.clock ?? systemClock;
  }

  capabilities(): ProviderCapabilities {
    return {
      tiktok: { ...DEFAULT_CAPABILITIES.tiktok, ...this.config.capabilities?.tiktok },
      instagram: { ...DEFAULT_CAPABILITIES.instagram, ...this.config.capabilities?.instagram },
    };
  }

  private submit(): SubmittedProviderJob {
    const plan = this.plannedJobs.shift();
    if (!plan) {
      throw new ProviderError("UPSTREAM", "fixture", "submit", "FixtureProvider ran out of planned jobs");
    }
    const externalJobId = `fixture-job-${this.nextJobId++}`;
    this.jobs.set(externalJobId, { plan, pollCount: 0 });
    return { externalJobId, submittedAt: this.clock.now() };
  }

  async submitDiscovery(input: DiscoveryJobInput): Promise<SubmittedProviderJob> {
    const cap = this.capabilities()[input.platform];
    if (!cap.discovery) {
      throw new ProviderError("UNSUPPORTED", "fixture", "submitDiscovery", `discovery unsupported for ${input.platform}`);
    }
    return this.submit();
  }

  async submitRefresh(input: RefreshJobInput): Promise<SubmittedProviderJob> {
    const cap = this.capabilities()[input.platform];
    if (!cap.refreshByUrl) {
      throw new ProviderError("UNSUPPORTED", "fixture", "submitRefresh", `refresh unsupported for ${input.platform}`);
    }
    return this.submit();
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const job = this.jobs.get(externalJobId);
    if (!job) {
      throw new ProviderError("NOT_FOUND", "fixture", "getStatus", `unknown job ${externalJobId}`);
    }
    job.pollCount += 1;

    let state: ProviderJobState;
    if (job.plan.failAfter !== undefined && job.pollCount >= job.plan.failAfter) {
      state = "FAILED";
    } else if (job.pollCount <= (job.plan.runningPolls ?? 0)) {
      state = "RUNNING";
    } else {
      state = "READY";
    }
    return { state, rawVendorStatus: `fixture:${state}` };
  }

  async fetchResults(externalJobId: string): Promise<ProviderResultPage> {
    const job = this.jobs.get(externalJobId);
    if (!job) {
      throw new ProviderError("NOT_FOUND", "fixture", "fetchResults", `unknown job ${externalJobId}`);
    }
    return { items: job.plan.items, nextCursor: null, truncated: false };
  }

  async cancel(externalJobId: string): Promise<void> {
    this.jobs.delete(externalJobId);
  }
}
