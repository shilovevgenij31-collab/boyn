/**
 * Pure webhook-request authentication (Phase 8 brief §9), separated from
 * the route handler so it's unit-testable without Next.js request
 * machinery — mirrors src/app/api/cron/tick/auth.ts's pattern. Never
 * echoes the supplied secret header value back in any result. Uses a
 * timing-safe comparison where the two values are even comparable
 * (brief §9's "where practical" — a length mismatch is rejected before
 * ever reaching `timingSafeEqual`, which itself requires equal-length
 * buffers).
 */
import { timingSafeEqual } from "node:crypto";

export type WebhookAuthResult = { ok: true } | { ok: false; status: 401 | 500; reason: string };

export function checkWebhookAuth(secretHeader: string | null, configuredSecret: string | undefined): WebhookAuthResult {
  if (!configuredSecret) {
    return { ok: false, status: 500, reason: "TELEGRAM_WEBHOOK_SECRET is not configured" };
  }
  if (!secretHeader) {
    return { ok: false, status: 401, reason: "missing X-Telegram-Bot-Api-Secret-Token header" };
  }

  const provided = Buffer.from(secretHeader, "utf8");
  const expected = Buffer.from(configuredSecret, "utf8");
  const matches = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!matches) {
    return { ok: false, status: 401, reason: "invalid secret token" };
  }
  return { ok: true };
}
