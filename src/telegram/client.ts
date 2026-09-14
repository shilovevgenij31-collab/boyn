/**
 * Thin typed Telegram Bot API client (Phase 8 brief §4, §13-15) — native
 * `fetch` only, no Telegram runtime framework. Only the methods this bot
 * actually needs (brief §13). Bounded retry for 429 (short waits only —
 * a long `retry_after` becomes a typed `RATE_LIMIT_DEFERRED` error
 * instead of blocking a serverless invocation for minutes) and 5xx/
 * network failures; 400-class errors never retry.
 *
 * The full request URL (`https://api.telegram.org/bot<TOKEN>/<method>`)
 * NEVER appears in a thrown error or log line — only the safe operation
 * name (`telegram.sendMessage`), per brief §14.
 */
import { TelegramError } from "./errors.ts";
import type {
  AnswerCallbackQueryParams,
  BotCommand,
  EditMessageTextParams,
  GetUpdatesParams,
  SendDocumentParams,
  SendMessageParams,
  SetWebhookParams,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.ts";

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  editMessageText(params: EditMessageTextParams): Promise<TelegramMessage | true>;
  answerCallbackQuery(params: AnswerCallbackQueryParams): Promise<true>;
  sendDocument(params: SendDocumentParams): Promise<TelegramMessage>;
  getUpdates(params?: GetUpdatesParams): Promise<TelegramUpdate[]>;
  setWebhook(params: SetWebhookParams): Promise<true>;
  deleteWebhook(): Promise<true>;
  setMyCommands(commands: BotCommand[]): Promise<true>;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
/** Telegram's own long-poll `timeout` param can legitimately make a
 * getUpdates call take longer than every other call here — a generous
 * per-attempt timeout keeps that from being treated as a network failure. */
const REQUEST_TIMEOUT_MS = 35_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = BACKOFF_BASE_MS * 4 ** (attempt - 1); // 1s, 4s
  return base + Math.random() * base * 0.2;
}

async function callTelegramApi<T>(token: string, method: string, init: RequestInit): Promise<T> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new TelegramError("NETWORK", `telegram.${method}`, `telegram.${method} failed after ${attempt} attempt(s): network error`, { cause: error });
    }
    clearTimeout(timer);

    const rawText = await response.text();
    let envelope: TelegramApiEnvelope<T> | null = null;
    try {
      envelope = rawText.length > 0 ? (JSON.parse(rawText) as TelegramApiEnvelope<T>) : null;
    } catch {
      envelope = null;
    }

    if (response.ok && envelope?.ok) {
      return envelope.result as T;
    }

    if (response.status === 429) {
      const retryAfterSec = envelope?.parameters?.retry_after ?? 1;
      if (retryAfterSec <= 10 && attempt < MAX_ATTEMPTS) {
        await sleep(retryAfterSec * 1000);
        continue;
      }
      throw new TelegramError("RATE_LIMIT_DEFERRED", `telegram.${method}`, `telegram.${method} rate-limited (retry_after=${retryAfterSec}s)`, {
        httpStatus: 429,
        retryAfterSec,
      });
    }

    if (response.status >= 500) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new TelegramError("SERVER_ERROR", `telegram.${method}`, `telegram.${method} failed after ${attempt} attempt(s): HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }

    // 400-class and any other non-retryable status: fail immediately, no retry.
    throw new TelegramError("BAD_REQUEST", `telegram.${method}`, `telegram.${method} failed: ${envelope?.description ?? `HTTP ${response.status}`}`, {
      httpStatus: response.status,
    });
  }
}

function postJson<T>(token: string, method: string, body?: unknown): Promise<T> {
  return callTelegramApi<T>(token, method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function createTelegramClient(token: string): TelegramClient {
  return {
    getMe: () => postJson<TelegramUser>(token, "getMe"),

    sendMessage: (params) => postJson<TelegramMessage>(token, "sendMessage", params),

    editMessageText: (params) => postJson<TelegramMessage | true>(token, "editMessageText", params),

    answerCallbackQuery: (params) => postJson<true>(token, "answerCallbackQuery", params),

    sendDocument: (params) => {
      const form = new FormData();
      form.append("chat_id", String(params.chat_id));
      if (params.caption) form.append("caption", params.caption);
      const blob = new Blob([params.content as BlobPart], { type: params.contentType ?? "application/octet-stream" });
      form.append("document", blob, params.filename);
      return callTelegramApi<TelegramMessage>(token, "sendDocument", { method: "POST", body: form });
    },

    getUpdates: (params) => postJson<TelegramUpdate[]>(token, "getUpdates", params ?? {}),

    setWebhook: (params) => postJson<true>(token, "setWebhook", params),

    deleteWebhook: () => postJson<true>(token, "deleteWebhook"),

    setMyCommands: (commands) => postJson<true>(token, "setMyCommands", { commands }),
  };
}
