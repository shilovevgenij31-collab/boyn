/**
 * Private-bot authorization (Phase 8 brief §7-8; Phase 8/9 hotfix —
 * multi-admin support). Two independent checks:
 *   - isAuthorized: allowed to use the bot at all (every admin implicitly
 *     included — brief §7's "admin implicitly has normal-user access").
 *   - isAdmin: allowed to use admin-only commands, checked ONLY by
 *     numeric `from.id` membership in the admin id set (brief §8) — never
 *     by username/display name, which Telegram lets any user change.
 *
 * Multiple admins are supported via `TELEGRAM_ADMIN_USER_IDS` (a
 * comma-separated list, same format/parsing as `TELEGRAM_ALLOWED_USER_IDS`)
 * alongside the original single `ADMIN_TELEGRAM_ID` — both are honored
 * together (`resolveAdminIds` unions them) so existing deployments that
 * only set `ADMIN_TELEGRAM_ID` keep working unchanged.
 */
export interface TelegramAuthConfig {
  allowedUserIds: ReadonlySet<number>;
  adminIds: ReadonlySet<number>;
}

/** `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list of numeric
 * Telegram user ids (env.ts's own comment on the field) — malformed
 * entries are dropped rather than crashing config load. */
export function parseAllowedUserIds(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

/** `TELEGRAM_ADMIN_USER_IDS` uses the identical comma-separated numeric-id
 * format/parsing rules as `TELEGRAM_ALLOWED_USER_IDS` — same trimming,
 * same malformed-entry handling, same dedup-by-Set. */
export function parseAdminUserIds(raw: string | undefined): Set<number> {
  return parseAllowedUserIds(raw);
}

export function parseAdminId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Unions the legacy single `ADMIN_TELEGRAM_ID` with the new
 * `TELEGRAM_ADMIN_USER_IDS` list into one admin id set. Both are honored
 * simultaneously — this is additive, never a replacement — so an
 * operator can grant a second admin without touching the first. */
export function resolveAdminIds(adminIdRaw: string | undefined, adminIdsRaw: string | undefined): Set<number> {
  const ids = parseAdminUserIds(adminIdsRaw);
  const legacyAdminId = parseAdminId(adminIdRaw);
  if (legacyAdminId !== null) ids.add(legacyAdminId);
  return ids;
}

export function isAuthorized(userId: number, config: TelegramAuthConfig): boolean {
  return config.adminIds.has(userId) || config.allowedUserIds.has(userId);
}

export function isAdmin(userId: number, config: TelegramAuthConfig): boolean {
  return config.adminIds.has(userId);
}
