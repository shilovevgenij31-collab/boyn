/**
 * Which vendor produced a post. Lives in core/domain (not src/providers/)
 * because NormalizedPost.source.provider needs it, and core must never
 * import from src/providers/** (CLAUDE.md rule 2) — the dependency has to
 * point the other way. src/providers/types.ts re-exports this for
 * provider-adapter code that wants a single import path.
 *
 * Scoped to exactly what Phase 2 normalizes — no "fixture" placeholder for
 * a future test-double provider that doesn't exist yet.
 */
export const PROVIDER_IDS = ["apify", "brightdata"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
