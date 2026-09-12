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
import type { ApifyVendorStatus } from "./client.ts";
import {
  buildApifyInstagramDiscoveryInput,
  buildApifyTikTokDiscoveryInput,
  buildApifyTikTokRefreshInput,
} from "./build-input.ts";

export interface ApifyProviderConfig {
  apiToken: string;
  actorTikTok: string;
  actorInstagram: string;
}

const PROVIDER = "apify";

/** Apify's OWN "READY" status means "queued, about to start" — a false
 * friend for our ProviderJobState.READY ("results ready to fetch"). Map
 * carefully rather than by name similarity. */
function mapVendorStatus(status: ApifyVendorStatus): ProviderJobState {
  switch (status) {
    case "SUCCEEDED":
      return "READY";
    case "FAILED":
    case "TIMED-OUT":
    case "ABORTED":
      return "FAILED";
    case "READY": // queued
    case "RUNNING":
    case "ABORTING":
    case "UNKNOWN": // ambiguous read — never treat as FAILED defensively
      return "RUNNING";
  }
}

export class ApifyProvider implements SocialDataProvider {
  readonly id = "apify" as const;

  constructor(private readonly config: ApifyProviderConfig) {}

  capabilities(): ProviderCapabilities {
    return {
      tiktok: { discovery: true, refreshByUrl: true, multiQueryAttribution: true },
      instagram: { discovery: true, refreshByUrl: false, multiQueryAttribution: false },
    };
  }

  async submitDiscovery(input: DiscoveryJobInput): Promise<SubmittedProviderJob> {
    const queries = input.queries.map((q) => q.query);
    const submittedAt = new Date();

    if (input.platform === "tiktok") {
      const body = buildApifyTikTokDiscoveryInput(queries, input.limitPerQuery);
      const run = await client.runActor(this.config.actorTikTok, this.config.apiToken, body);
      return { externalJobId: run.runId, submittedAt };
    }
    if (input.platform === "instagram") {
      const body = buildApifyInstagramDiscoveryInput(queries, input.limitPerQuery);
      const run = await client.runActor(this.config.actorInstagram, this.config.apiToken, body);
      return { externalJobId: run.runId, submittedAt };
    }
    throw new ProviderError("UNSUPPORTED", PROVIDER, "submitDiscovery", `unsupported platform: ${input.platform}`);
  }

  async submitRefresh(input: RefreshJobInput): Promise<SubmittedProviderJob> {
    if (input.platform !== "tiktok") {
      throw new ProviderError(
        "UNSUPPORTED",
        PROVIDER,
        "submitRefresh",
        `Apify refresh is only supported for tiktok, not ${input.platform}`,
      );
    }
    const body = buildApifyTikTokRefreshInput(input.posts.map((p) => p.canonicalUrl));
    const run = await client.runActor(this.config.actorTikTok, this.config.apiToken, body);
    return { externalJobId: run.runId, submittedAt: new Date() };
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const info = await client.getRunInfo(externalJobId, this.config.apiToken);
    return { state: mapVendorStatus(info.status), rawVendorStatus: info.status };
  }

  async fetchResults(externalJobId: string): Promise<ProviderResultPage> {
    const info = await client.getRunInfo(externalJobId, this.config.apiToken);
    if (!info.defaultDatasetId) {
      throw new ProviderError(
        "UPSTREAM",
        PROVIDER,
        "fetchResults",
        `run ${externalJobId} has no defaultDatasetId (status=${info.status})`,
      );
    }
    const items = await client.getDatasetItems(info.defaultDatasetId, this.config.apiToken);
    // Apify's items endpoint returns the full dataset in one call for our
    // small (<=100 item) job sizes — pagination via limit/offset exists on
    // the API but was never exercised (our jobs never approached a size
    // where it would matter), so this honestly reports "not truncated"
    // rather than implementing unverified paging logic.
    return { items, nextCursor: null, truncated: false };
  }

  async cancel(externalJobId: string): Promise<void> {
    await client.abortRun(externalJobId, this.config.apiToken);
  }
}
