/**
 * Telegram-layer error taxonomy (Phase 8 brief §14-15), mirroring
 * src/providers/errors.ts's shape. A TelegramError's `message` is always
 * a safe, human-readable operation name (`telegram.sendMessage`) — never
 * a full Bot API URL, which embeds the token as `bot<TOKEN>` in its path.
 */
export type TelegramErrorCode = "RATE_LIMIT_DEFERRED" | "RATE_LIMIT" | "SERVER_ERROR" | "BAD_REQUEST" | "NETWORK" | "UNKNOWN";

export interface TelegramErrorOptions {
  httpStatus?: number;
  /** Present only for RATE_LIMIT_DEFERRED — how long Telegram asked us to
   * wait before retrying (brief §15: >10s is not worth a bounded retry). */
  retryAfterSec?: number;
  cause?: unknown;
}

export class TelegramError extends Error {
  readonly code: TelegramErrorCode;
  readonly operation: string;
  readonly httpStatus: number | null;
  readonly retryAfterSec: number | null;

  constructor(code: TelegramErrorCode, operation: string, message: string, options: TelegramErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TelegramError";
    this.code = code;
    this.operation = operation;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterSec = options.retryAfterSec ?? null;
  }
}

export function isTelegramError(error: unknown): error is TelegramError {
  return error instanceof TelegramError;
}
