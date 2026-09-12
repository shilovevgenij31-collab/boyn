/**
 * The production job-shaped provider abstraction (Phase 4 brief §2).
 * Both real vendors are asynchronous (a discovery/refresh job can take
 * anywhere from seconds to several minutes — Bright Data measured
 * 4-6 minutes in Phase 1B), so this is deliberately submit/poll/fetch,
 * never a fake synchronous `search(): Promise<Post[]>` that would have to
 * block an HTTP request handler for minutes.
 *
 * Distinct from src/providers/types.ts (Phase 2's normalization dispatch
 * contracts, e.g. NormalizeProviderPostParams) — that file is about
 * turning an already-fetched raw item into a NormalizedPost; this one is
 * about fetching the raw items in the first place.
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { Market } from "@/core/domain/market.ts";
import type { ProviderId } from "@/core/domain/provider.ts";

/** `SocialDataProvider.id` — a superset of the DB-persisted ProviderId
 * (Phase 2 deliberately excluded "fixture" from that enum, since nothing
 * persists it; the interface still needs a way to identify the test
 * double). Never write "fixture" to provider_jobs.provider — the DB enum
 * doesn't have it and never should. */
export type RuntimeProviderId = ProviderId | "fixture";

export interface PlatformCapability {
  discovery: boolean;
  refreshByUrl: boolean;
  /** Can each returned item be attributed to the specific query that
   * found it? Only ever `true` when a real, verified vendor field
   * carries that information (Phase 1B: Apify TikTok search mode's
   * `searchQuery` field, Bright Data's `discovery_input.search_keyword`)
   * — never inferred/guessed at this layer (Phase 4 brief §25). */
  multiQueryAttribution: boolean;
}

export interface ProviderCapabilities {
  tiktok: PlatformCapability;
  instagram: PlatformCapability;
}

export interface DiscoveryQuery {
  /** Already run through core/normalize/query.ts — bare, lowercase, no "#". */
  query: string;
  /** For provenance (post_discoveries.hashtag_id) when this query IS a
   * tracked hashtag row, not just free-text. */
  hashtagId?: number | null;
}

export interface DiscoveryJobInput {
  platform: Platform;
  market: Market;
  queries: DiscoveryQuery[];
  limitPerQuery: number;
}

export interface RefreshPostRef {
  externalId: string;
  canonicalUrl: string;
}

export interface RefreshJobInput {
  platform: Platform;
  posts: RefreshPostRef[];
}

export interface SubmittedProviderJob {
  externalJobId: string;
  submittedAt: Date;
}

/**
 * Provider-neutral job state — vendor status strings never leak past the
 * adapter that produced them (Phase 4 brief §23). `rawVendorStatus` is
 * kept ONLY as safe diagnostic text (e.g. "SUCCEEDED", "ready") for logs/
 * provider_jobs.error, never a full response object.
 */
export type ProviderJobState = "SUBMITTED" | "RUNNING" | "READY" | "FAILED";

export interface ProviderJobStatus {
  state: ProviderJobState;
  rawVendorStatus: string;
}

export interface ProviderResultPage {
  items: unknown[];
  nextCursor: string | null;
  /** True if the provider signaled more results exist beyond this page
   * (Phase 4 brief §24) — callers must not silently drop them. Always
   * `false` where pagination was never verified (Bright Data's snapshot
   * endpoint, per Phase 1B) rather than guessed. */
  truncated: boolean;
}

export interface SocialDataProvider {
  readonly id: RuntimeProviderId;

  capabilities(): ProviderCapabilities;

  /** Throws ProviderError("UNSUPPORTED") if `input.platform` isn't a
   * supported discovery platform for this provider — check
   * `capabilities()` first to avoid relying on the throw for control flow. */
  submitDiscovery(input: DiscoveryJobInput): Promise<SubmittedProviderJob>;

  /** Throws ProviderError("UNSUPPORTED") if refresh isn't supported for
   * `input.platform` on this provider. */
  submitRefresh(input: RefreshJobInput): Promise<SubmittedProviderJob>;

  getStatus(externalJobId: string): Promise<ProviderJobStatus>;

  fetchResults(externalJobId: string, cursor?: string): Promise<ProviderResultPage>;

  cancel?(externalJobId: string): Promise<void>;
}
