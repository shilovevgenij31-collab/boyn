/**
 * Update validation (Phase 8 brief §10, §78).
 */
import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "@/telegram/update-schema.ts";

describe("parseTelegramUpdate", () => {
  it("accepts a real-shaped message update", () => {
    const raw = { update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: false, first_name: "A" }, chat: { id: 1, type: "private" }, date: 0, text: "/today" } };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
  });

  it("accepts a real-shaped callback_query update", () => {
    const raw = { update_id: 2, callback_query: { id: "cbq1", from: { id: 1, is_bot: false, first_name: "A" }, message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 }, data: "pg:abc:2" } };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
  });

  it("rejects an update missing update_id", () => {
    const result = parseTelegramUpdate({ message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } });
    expect(result.ok).toBe(false);
  });

  it("accepts (as a no-op) an update of an unhandled type, e.g. edited_message, since update_id is present", () => {
    const raw = { update_id: 3, edited_message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0, text: "hi" } };
    const result = parseTelegramUpdate(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.update.message).toBeUndefined();
      expect(result.update.callback_query).toBeUndefined();
    }
  });

  it("never blindly casts arbitrary JSON — rejects garbage", () => {
    expect(parseTelegramUpdate(null).ok).toBe(false);
    expect(parseTelegramUpdate("a string").ok).toBe(false);
    expect(parseTelegramUpdate(42).ok).toBe(false);
    expect(parseTelegramUpdate({}).ok).toBe(false);
    expect(parseTelegramUpdate({ update_id: "not-a-number" }).ok).toBe(false);
  });

  it("rejects a message with a malformed chat", () => {
    const raw = { update_id: 4, message: { message_id: 1, chat: { id: "not-a-number", type: "private" }, date: 0 } };
    expect(parseTelegramUpdate(raw).ok).toBe(false);
  });
});
