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
import * as client from "./client.ts";
import type { BrightDataVendorStatus } from "./client.ts";
import { BRIGHTDATA_DISCOVERY_QUERY, buildBrightDataTikTokDiscoveryInput } from "./build-input.ts";

export interface BrightDataProviderConfig {
  apiToken: string;
  datasetTikTokPosts: string;
}

const PROVIDER = "brightdata";

function mapVendorStatus(status: BrightDataVendorStatus): ProviderJobState {
  switch (status) {
    case "ready":
      return "READY";
    case "failed":
      return "FAILED";
    case "starting":
    case "running":
    case "unknown": // Phase 1B: an ambiguous read during a long-running job must
      // never be treated as failure — this is the exact false-negative that
      // produced a wrong BLOCKED verdict there.
      return "RUNNING";
  }
}

/**
 * TikTok discovery FALLBACK only (median age ~31 days / 16.7% <24h in
 * Phase 1B — real, working, but far less fresh than Apify's search mode;
 * routing decides when this is actually used, this adapter just
 * correctly executes the one capability the spike verified: keyword
 * discovery). No Instagram support (no verified endpoint on this
 * account) and no refresh (Collect-by-URL IS verified working per Phase
 * 1B, but is explicitly out of Phase 4 scope per the approved routing
 * table — Apify covers TikTok refresh).
 */
export class BrightDataProvider implements SocialDataProvider {
  readonly id = "brightdata" as const;

  constructor(private readonly config: BrightDataProviderConfig) {}

  capabilities(): ProviderCapabilities {
    return {
      tiktok: { discovery: true, refreshByUrl: false, multiQueryAttribution: true },
      instagram: { discovery: false, refreshByUrl: false, multiQueryAttribution: false },
    };
  }

  async submitDiscovery(input: DiscoveryJobInput): Promise<SubmittedProviderJob> {
    if (input.platform !== "tiktok") {
      throw new ProviderError(
        "UNSUPPORTED",
        PROVIDER,
        "submitDiscovery",
        `Bright Data discovery is only supported for tiktok, not ${input.platform}`,
      );
    }
    const body = buildBrightDataTikTokDiscoveryInput(
      input.queries.map((q) => q.query),
      input.limitPerQuery,
    );
    const submittedAt = new Date();
    const result = await client.submitDiscovery({
      datasetId: this.config.datasetTikTokPosts,
      apiToken: this.config.apiToken,
      body,
      extraQuery: BRIGHTDATA_DISCOVERY_QUERY,
    });

    if (!result.snapshotId) {
      // Never observed for our real job sizes in Phase 1/1B — every real
      // discovery call returned an async snapshot_id. A direct/synchronous
      // response here is an untested shape, not a silently-supported one.
      throw new ProviderError(
        "UPSTREAM",
        PROVIDER,
        "submitDiscovery",
        "received a synchronous direct-array response — the production adapter only supports the async snapshot_id path verified in Phase 1/1B",
      );
    }
    return { externalJobId: result.snapshotId, submittedAt };
  }

  // Deliberately `async` (not just `Promise<...>`-typed) so this rejects
  // the returned Promise instead of throwing synchronously, which would
  // break a `.catch()`-style caller that never gets to `await` the call
  // expression itself.
  async submitRefresh(input: RefreshJobInput): Promise<SubmittedProviderJob> {
    throw new ProviderError(
      "UNSUPPORTED",
      PROVIDER,
      "submitRefresh",
      // Collect-by-URL IS a verified Bright Data capability (Phase 1B) —
      // deliberately not wired up: Apify is the approved TikTok refresh
      // provider (docs/IMPLEMENTATION_PLAN.md ADR-024) and Bright Data
      // Instagram has no discovery path at all.
      `Bright Data refresh is not implemented for ${input.platform} (out of Phase 4 scope — see ADR-024)`,
    );
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const status = await client.getProgress(externalJobId, this.config.apiToken);
    return { state: mapVendorStatus(status), rawVendorStatus: status };
  }

  async fetchResults(externalJobId: string): Promise<ProviderResultPage> {
    const items = await client.getSnapshot(externalJobId, this.config.apiToken);
    // Pagination on /snapshot was never verified in Phase 1/1B (our jobs
    // were small); reporting anything but "not truncated" here would be a
    // guess, not a finding.
    return { items, nextCursor: null, truncated: false };
  }

  // No cancel(): Bright Data snapshot cancellation was never verified —
  // omitting it (the interface marks `cancel` optional) is honest, not a gap.
}
