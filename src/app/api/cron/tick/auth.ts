/**
 * Pure cron-request authentication (Phase 5 brief §40-41), separated from
 * the route handler so it's unit-testable without Next.js request
 * machinery. Never echoes the supplied Authorization header value back in
 * any result — only a generic reason string.
 */
export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 500; reason: string };

export function checkCronAuth(authorizationHeader: string | null, configuredSecret: string | undefined): CronAuthResult {
  if (!configuredSecret) {
    // Fail closed: an unconfigured secret must never be treated as "no
    // auth required", in any environment.
    return { ok: false, status: 500, reason: "CRON_SECRET is not configured" };
  }
  if (authorizationHeader !== `Bearer ${configuredSecret}`) {
    return { ok: false, status: 401, reason: "invalid or missing Authorization header" };
  }
  return { ok: true };
}
