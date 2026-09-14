/**
 * Minimal hand-written Telegram Bot API types (Phase 8 brief §4) — only
 * the shapes this bot actually sends/receives. No runtime framework
 * dependency; these are structural types matching the subset of the real
 * Bot API documented at https://core.telegram.org/bots/api, used to keep
 * `src/telegram/*` and its tests type-safe without pulling in a full
 * Telegram SDK.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export interface SendMessageParams {
  chat_id: number;
  text: string;
  parse_mode?: "HTML";
  disable_web_page_preview?: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

export interface EditMessageTextParams {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "HTML";
  disable_web_page_preview?: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface SendDocumentParams {
  chat_id: number;
  filename: string;
  content: string | Uint8Array;
  contentType?: string;
  caption?: string;
}

export interface SetWebhookParams {
  url: string;
  secret_token: string;
  allowed_updates?: string[];
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface GetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}
