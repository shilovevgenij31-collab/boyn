/**
 * Private-bot authorization (Phase 8 brief §7-8). Two independent checks:
 *   - isAuthorized: allowed to use the bot at all (admin implicitly
 *     included — brief §7's "admin implicitly has normal-user access").
 *   - isAdmin: allowed to use admin-only commands, checked ONLY by
 *     numeric `from.id === ADMIN_TELEGRAM_ID` (brief §8) — never by
 *     username/display name, which Telegram lets any user change.
 */
export interface TelegramAuthConfig {
  allowedUserIds: ReadonlySet<number>;
  adminId: number | null;
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

export function parseAdminId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function isAuthorized(userId: number, config: TelegramAuthConfig): boolean {
  return userId === config.adminId || config.allowedUserIds.has(userId);
}

export function isAdmin(userId: number, config: TelegramAuthConfig): boolean {
  return config.adminId !== null && userId === config.adminId;
}
