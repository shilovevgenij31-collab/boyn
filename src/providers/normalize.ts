import { assertNever } from "@/lib/exhaustive.ts";
import type { NormalizeResult } from "@/core/domain/social-post.ts";
import type { NormalizeProviderPostParams } from "./types.ts";
import { normalizeApifyTikTok } from "./apify/normalize-tiktok.ts";
import { normalizeApifyInstagram } from "./apify/normalize-instagram.ts";
import { normalizeBrightDataTikTok } from "./brightdata/normalize-tiktok.ts";

type DispatchKey = `${NormalizeProviderPostParams["provider"]}_${NormalizeProviderPostParams["platform"]}`;

/**
 * Normalization dispatch — routes a raw provider item to the correct
 * (provider, platform) normalizer. This is normalization plumbing only,
 * not the production SocialDataProvider orchestration (Phase 4): it takes
 * an already-fetched raw item and a context, nothing more.
 */
export function normalizeProviderPost(params: NormalizeProviderPostParams): NormalizeResult {
  const key: DispatchKey = `${params.provider}_${params.platform}`;

  switch (key) {
    case "apify_tiktok":
      return normalizeApifyTikTok(params.raw, params.context);
    case "apify_instagram":
      return normalizeApifyInstagram(params.raw, params.context);
    case "brightdata_tiktok":
      return normalizeBrightDataTikTok(params.raw, params.context);
    case "brightdata_instagram":
      // No verified Instagram hashtag-discovery endpoint on this account
      // (see docs/PROVIDER_SPIKE.md) — never attempted, so there is no
      // real schema to normalize against. Explicit, not a silent gap.
      return {
        ok: false,
        kind: "UNSUPPORTED",
        reason: "Bright Data Instagram has no verified discovery endpoint — not normalized in Phase 2",
      };
    default:
      return assertNever(key, "normalizeProviderPost");
  }
}
