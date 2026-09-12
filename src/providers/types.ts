import type { Platform } from "@/core/domain/platform.ts";
import type { NormalizeContext, NormalizeResult } from "@/core/domain/social-post.ts";
import type { ProviderId } from "@/core/domain/provider.ts";

// Re-exported here so provider-adapter code has one import path, even
// though the type itself lives in core/domain (NormalizedPost needs it,
// and core must never import from src/providers/**).
export type { ProviderId } from "@/core/domain/provider.ts";
export { PROVIDER_IDS, isProviderId } from "@/core/domain/provider.ts";

/** A single (provider, platform) normalizer's shape — every
 * `normalize<Provider><Platform>` function under src/providers/
 * conforms to this. */
export type PlatformNormalizer = (raw: unknown, context: NormalizeContext) => NormalizeResult;

/** Params for the dispatch function in src/providers/normalize.ts. */
export interface NormalizeProviderPostParams {
  provider: ProviderId;
  platform: Platform;
  raw: unknown;
  context: NormalizeContext;
}
