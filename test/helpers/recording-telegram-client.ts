/**
 * Fake/recording TelegramClient (Phase 8 brief §72) — every method call
 * is captured for assertions; no network. Keeps all normal tests offline
 * (brief §41 of the Definition of Done).
 */
import type { TelegramClient } from "@/telegram/client.ts";
import type {
  AnswerCallbackQueryParams,
  BotCommand,
  EditMessageTextParams,
  SendDocumentParams,
  SendMessageParams,
  SetWebhookParams,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "@/telegram/types.ts";

export interface RecordingTelegramClient extends TelegramClient {
  sentMessages: SendMessageParams[];
  edits: EditMessageTextParams[];
  answeredCallbacks: AnswerCallbackQueryParams[];
  sentDocuments: SendDocumentParams[];
  setMyCommandsCalls: BotCommand[][];
  setWebhookCalls: SetWebhookParams[];
  deleteWebhookCalls: number;
  nextMessageId: number;
}

let counter = 0;

export function createRecordingTelegramClient(overrides: Partial<{ me: TelegramUser; updates: TelegramUpdate[] }> = {}): RecordingTelegramClient {
  const state: RecordingTelegramClient = {
    sentMessages: [],
    edits: [],
    answeredCallbacks: [],
    sentDocuments: [],
    setMyCommandsCalls: [],
    setWebhookCalls: [],
    deleteWebhookCalls: 0,
    nextMessageId: 1,

    getMe: async () => overrides.me ?? { id: 1, is_bot: true, first_name: "Trend Radar", username: "iiinstttta_bot" },

    sendMessage: async (params: SendMessageParams): Promise<TelegramMessage> => {
      state.sentMessages.push(params);
      counter += 1;
      return { message_id: counter, chat: { id: params.chat_id, type: "private" }, date: 0, text: params.text };
    },

    editMessageText: async (params: EditMessageTextParams): Promise<TelegramMessage> => {
      state.edits.push(params);
      return { message_id: params.message_id, chat: { id: params.chat_id, type: "private" }, date: 0, text: params.text };
    },

    answerCallbackQuery: async (params: AnswerCallbackQueryParams): Promise<true> => {
      state.answeredCallbacks.push(params);
      return true;
    },

    sendDocument: async (params: SendDocumentParams): Promise<TelegramMessage> => {
      state.sentDocuments.push(params);
      counter += 1;
      return { message_id: counter, chat: { id: params.chat_id, type: "private" }, date: 0 };
    },

    getUpdates: async (): Promise<TelegramUpdate[]> => overrides.updates ?? [],

    setWebhook: async (params: SetWebhookParams): Promise<true> => {
      state.setWebhookCalls.push(params);
      return true;
    },

    deleteWebhook: async (): Promise<true> => {
      state.deleteWebhookCalls += 1;
      return true;
    },

    setMyCommands: async (commands: BotCommand[]): Promise<true> => {
      state.setMyCommandsCalls.push(commands);
      return true;
    },
  };
  return state;
}
