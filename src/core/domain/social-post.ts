import type { Platform } from "./platform.ts";
import type { ContentType } from "./content-type.ts";
import type { ViewsMetric } from "./views-metric.ts";
import type { ProviderId } from "./provider.ts";

/**
 * The stable, provider-independent representation every future phase
 * consumes. Nothing outside `src/providers/**` should need to know which
 * vendor produced a post, what its raw field names were, or whether a
 * metric was simply unavailable for this platform/provider.
 */
export interface NormalizedPost {
  platform: Platform;

  /** Stable across rediscovery — see canonical-url.ts and each provider
   * normalizer's module comment for exactly how this is derived per
   * platform. Used with `platform` as the future DB dedup key. */
  externalId: string;

  /** Always an original tiktok.com / instagram.com permalink — see
   * core/normalize/canonical-url.ts. Never a provider/CDN URL. */
  canonicalUrl: string;

  contentType: ContentType;

  creator: {
    username: string | null;
    externalId: string | null;
    followers: number | null;
    verified: boolean | null;
  };

  /** Raw caption/description text, unmodified. `null` only when genuinely
   * absent — never coerced to `""`. Telegram escaping/truncation is a
   * presentation concern handled elsewhere, not here. */
  caption: string | null;

  /** Normalized, deduplicated, Unicode-preserving hashtag names (no
   * leading "#"). Merged from the provider's own hashtag field and any
   * `#tag` found in the caption. Generic tags (fyp, viral, ...) are kept —
   * stoplist filtering is an analytics/taxonomy concern, not normalization. */
  hashtags: string[];

  music: {
    id: string | null;
    title: string | null;
    author: string | null;
  } | null;

  /** `null` when the raw timestamp is missing or unparseable — the post
   * can still be otherwise useful (identity/link/metrics), so a bad date
   * alone does not fail normalization. */
  publishedAt: Date | null;

  durationSec: number | null;

  metrics: {
    /** `views` and `viewsMetric` always agree: both null, or both set from
     * the same field. Never converted from "missing" to 0. */
    views: number | null;
    viewsMetric: ViewsMetric | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
  };

  /** When OUR system observed this provider result — never derived from
   * the raw payload. Supplied by the caller via NormalizeContext so
   * normalization stays deterministic in tests. */
  observedAt: Date;

  source: {
    provider: ProviderId;
    /** Caller-supplied context (e.g. "search", "hashtag", "keyword",
     * "refresh"), not parsed from the raw payload — see NormalizeContext. */
    discoveryMethod: string | null;
  };
}

/** Context a normalizer needs that cannot come from the raw payload itself. */
export interface NormalizeContext {
  observedAt: Date;
  discoveryMethod?: string | null;
}

/**
 * Deliberately small: only failure kinds Phase 2's normalizers can
 * actually produce from real data are included.
 *   INVALID          - raw payload fails schema validation (wrong shape/types)
 *   MISSING_ID        - no usable stable identifier present
 *   INVALID_URL       - no valid original-platform canonical URL could be built
 *   UNSUPPORTED       - well-formed but a (provider, platform) pair we don't
 *                       normalize (e.g. Bright Data Instagram — no verified
 *                       discovery endpoint, see PROVIDER_SPIKE.md)
 * DELETED/PRIVATE are intentionally NOT included yet: no real fixture ever
 * exercised that path, and inventing detection logic for it now would be
 * exactly the "designed from documentation, not fixtures" mistake this
 * phase is supposed to avoid. Add them when a real refresh-by-URL case
 * (Phase 4+) actually needs to represent one.
 */
export type NormalizeFailureKind = "INVALID" | "MISSING_ID" | "INVALID_URL" | "UNSUPPORTED";

export interface NormalizeFailure {
  ok: false;
  kind: NormalizeFailureKind;
  reason: string;
  /** Present only for kind === "INVALID" (Zod issues). */
  issues?: unknown;
}

export interface NormalizeSuccess {
  ok: true;
  post: NormalizedPost;
}

export type NormalizeResult = NormalizeSuccess | NormalizeFailure;
