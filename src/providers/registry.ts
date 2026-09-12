/**
 * Resolves which provider instance(s) handle a (platform, operation).
 * Routing table is the FINAL, evidence-based decision from Phase 1/1B
 * (docs/IMPLEMENTATION_PLAN.md ADR-024) — see module-level DEFAULT_CONFIG.
 *
 * Discovery routing (primary + optional fallback) is env-overridable via
 * the existing PROVIDER_TIKTOK_PRIMARY/FALLBACK and
 * PROVIDER_INSTAGRAM_PRIMARY/FALLBACK vars. Refresh routing is NOT
 * configurable — there is exactly one supported choice per platform
 * (tiktok -> apify, instagram -> unsupported) and no fallback concept for
 * it in the MVP, so adding env vars for it would be pure configuration
 * surface with no real choice behind it (Phase 4 brief §16: "avoid
 * configuration explosion").
 */
import type { Platform } from "@/core/domain/platform.ts";
import type { ProviderId } from "@/core/domain/provider.ts";
import type { Env } from "@/config/env.ts";
import { ProviderError } from "./errors.ts";
import type { ProviderOperation } from "./circuit-breaker.ts";
import type { CircuitBreaker } from "./circuit-breaker.ts";
import type { RuntimeProviderId, SocialDataProvider } from "./provider.ts";

export interface RegistryConfig {
  tiktokDiscoveryPrimary: ProviderId;
  tiktokDiscoveryFallback: ProviderId | null;
  instagramDiscoveryPrimary: ProviderId;
  instagramDiscoveryFallback: ProviderId | null;
}

export const DEFAULT_REGISTRY_CONFIG: RegistryConfig = {
  tiktokDiscoveryPrimary: "apify",
  tiktokDiscoveryFallback: "brightdata",
  instagramDiscoveryPrimary: "apify",
  instagramDiscoveryFallback: null,
};

/** Fixed, non-configurable refresh routing — see module doc comment. */
const REFRESH_PROVIDER: Record<Platform, ProviderId | null> = {
  tiktok: "apify",
  instagram: null,
};

export function buildRegistryConfigFromEnv(env: Env): RegistryConfig {
  return {
    tiktokDiscoveryPrimary: env.PROVIDER_TIKTOK_PRIMARY ?? DEFAULT_REGISTRY_CONFIG.tiktokDiscoveryPrimary,
    tiktokDiscoveryFallback:
      env.PROVIDER_TIKTOK_FALLBACK ?? DEFAULT_REGISTRY_CONFIG.tiktokDiscoveryFallback,
    instagramDiscoveryPrimary:
      env.PROVIDER_INSTAGRAM_PRIMARY ?? DEFAULT_REGISTRY_CONFIG.instagramDiscoveryPrimary,
    instagramDiscoveryFallback:
      env.PROVIDER_INSTAGRAM_FALLBACK ?? DEFAULT_REGISTRY_CONFIG.instagramDiscoveryFallback,
  };
}

export interface ResolvedRoute {
  primary: SocialDataProvider;
  fallback: SocialDataProvider | null;
}

export class ProviderRegistry {
  constructor(
    private readonly providers: Partial<Record<RuntimeProviderId, SocialDataProvider>>,
    private readonly config: RegistryConfig = DEFAULT_REGISTRY_CONFIG,
  ) {}

  private getProviderInstance(id: ProviderId): SocialDataProvider {
    const provider = this.providers[id];
    if (!provider) {
      throw new ProviderError("UNSUPPORTED", "registry", "resolve", `no provider instance registered for "${id}"`);
    }
    return provider;
  }

  /** Direct lookup by a specific, already-decided provider id — no
   * routing/fallback logic. Used by the submit phase (Phase 5), which
   * already knows which provider a planned job was persisted against and
   * just needs the instance to call. */
  getById(id: ProviderId): SocialDataProvider {
    return this.getProviderInstance(id);
  }

  private assertSupports(provider: SocialDataProvider, platform: Platform, operation: ProviderOperation): void {
    const cap = provider.capabilities()[platform];
    const supported = operation === "DISCOVERY" ? cap.discovery : cap.refreshByUrl;
    if (!supported) {
      throw new ProviderError(
        "UNSUPPORTED",
        provider.id,
        operation,
        `${provider.id} does not support ${operation} for ${platform} — check capabilities() before calling resolve()`,
      );
    }
  }

  /** Pure routing-table lookup (no I/O, no circuit-breaker awareness) —
   * validated against each candidate's own capabilities(), so a
   * misconfigured env var (e.g. pointing TikTok discovery at a provider
   * that can't do it) fails loudly here rather than routing silently. */
  resolve(platform: Platform, operation: ProviderOperation): ResolvedRoute {
    if (operation === "DISCOVERY") {
      const primaryId = platform === "tiktok" ? this.config.tiktokDiscoveryPrimary : this.config.instagramDiscoveryPrimary;
      const fallbackId =
        platform === "tiktok" ? this.config.tiktokDiscoveryFallback : this.config.instagramDiscoveryFallback;

      const primary = this.getProviderInstance(primaryId);
      this.assertSupports(primary, platform, "DISCOVERY");

      let fallback: SocialDataProvider | null = null;
      if (fallbackId) {
        fallback = this.getProviderInstance(fallbackId);
        this.assertSupports(fallback, platform, "DISCOVERY");
      }
      return { primary, fallback };
    }

    const primaryId = REFRESH_PROVIDER[platform];
    if (!primaryId) {
      throw new ProviderError("UNSUPPORTED", "registry", "REFRESH", `refresh is not supported for ${platform}`);
    }
    const primary = this.getProviderInstance(primaryId);
    this.assertSupports(primary, platform, "REFRESH");
    return { primary, fallback: null };
  }

  /**
   * Circuit-aware selection: primary if its circuit is closed/half-open,
   * else fallback under the same condition, else throws. Doesn't itself
   * record success/failure — the caller does that around the actual
   * submit call (this only decides which provider to try).
   *
   * Deliberately does NOT call `resolve()` (which eagerly instantiates
   * BOTH primary and fallback to validate the full routing table): a
   * deploy that only has Apify credentials configured, with Bright Data
   * genuinely absent (not misconfigured — just not set up), must still be
   * able to use a healthy Apify primary. The fallback instance is only
   * looked up — and only then required to exist — once the primary is
   * actually found unavailable.
   */
  async resolveAvailable(
    platform: Platform,
    operation: ProviderOperation,
    circuitBreaker: CircuitBreaker,
  ): Promise<SocialDataProvider> {
    const primaryId = this.primaryProviderId(platform, operation);
    const primary = this.getProviderInstance(primaryId);
    this.assertSupports(primary, platform, operation);

    if (await circuitBreaker.isAvailable({ provider: primary.id as ProviderId, platform, operation })) {
      return primary;
    }

    const fallbackId = this.fallbackProviderId(platform, operation);
    if (fallbackId) {
      const fallback = this.getProviderInstance(fallbackId);
      this.assertSupports(fallback, platform, operation);
      if (await circuitBreaker.isAvailable({ provider: fallback.id as ProviderId, platform, operation })) {
        return fallback;
      }
    }

    throw new ProviderError(
      "UPSTREAM",
      "registry",
      operation,
      `no available provider for ${platform} ${operation}: primary (${primary.id}) circuit open${fallbackId ? `, fallback (${fallbackId}) circuit open` : ", no fallback configured"}`,
    );
  }

  private primaryProviderId(platform: Platform, operation: ProviderOperation): ProviderId {
    if (operation === "REFRESH") {
      const primaryId = REFRESH_PROVIDER[platform];
      if (!primaryId) {
        throw new ProviderError("UNSUPPORTED", "registry", "REFRESH", `refresh is not supported for ${platform}`);
      }
      return primaryId;
    }
    return platform === "tiktok" ? this.config.tiktokDiscoveryPrimary : this.config.instagramDiscoveryPrimary;
  }

  private fallbackProviderId(platform: Platform, operation: ProviderOperation): ProviderId | null {
    if (operation === "REFRESH") return null;
    return platform === "tiktok" ? this.config.tiktokDiscoveryFallback : this.config.instagramDiscoveryFallback;
  }
}
