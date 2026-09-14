/**
 * Incoming Telegram Update validation (Phase 8 brief §10) — never blindly
 * casts arbitrary JSON to TelegramUpdate. Only `message`/`callback_query`
 * are modeled; any other update type (`edited_message`, `channel_post`,
 * ...) fails this schema's `.safeParse` and the caller treats it as
 * "acknowledge and ignore safely" rather than a validation error, since
 * it's a legitimate Telegram update we simply don't act on.
 */
import { z } from "zod";
import type { TelegramUpdate } from "./types.ts";

const userSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

const chatSchema = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

const messageSchema = z.object({
  message_id: z.number(),
  from: userSchema.optional(),
  chat: chatSchema,
  date: z.number(),
  text: z.string().optional(),
});

const callbackQuerySchema = z.object({
  id: z.string(),
  from: userSchema,
  message: messageSchema.optional(),
  data: z.string().optional(),
});

/** `update_id` is the only field required for every update — dedupe
 * depends on it existing even when we don't recognize the rest of the
 * shape. */
const updateSchema = z.object({
  update_id: z.number(),
  message: messageSchema.optional(),
  callback_query: callbackQuerySchema.optional(),
});

export type ParsedUpdate = z.infer<typeof updateSchema>;

export function parseTelegramUpdate(raw: unknown): { ok: true; update: TelegramUpdate } | { ok: false; error: string } {
  const result = updateSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, update: result.data };
}
