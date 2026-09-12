/**
 * A market is a geographic/audience scope for discovery and ranking (e.g. a
 * country or region) — it is deliberately NOT a language. Content in many
 * languages can share one market, and the same language can span markets.
 * `language` is a separate, optional field elsewhere in the domain (e.g. on
 * a post) and is unused/unknown for the MVP.
 *
 * `"global"` is a real, valid market value meaning "undifferentiated
 * worldwide discovery" — it is not a placeholder for "no market configured".
 * See docs/IMPLEMENTATION_PLAN.md ADR-020.
 */
export const GLOBAL_MARKET = "global";

export type Market = string;

const MARKET_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export function isValidMarket(value: string): value is Market {
  return MARKET_PATTERN.test(value);
}
