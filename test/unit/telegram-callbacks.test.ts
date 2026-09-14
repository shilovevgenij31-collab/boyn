/**
 * Pagination callback_data encoding (Phase 8 brief §19, §75).
 */
import { describe, expect, it } from "vitest";
import { buildPaginationCallbackData, parsePaginationCallbackData } from "@/telegram/callbacks.ts";
import { generateResultViewId } from "@/db/repositories/result-views.ts";

describe("buildPaginationCallbackData / parsePaginationCallbackData", () => {
  it("round-trips viewId and page", () => {
    const viewId = generateResultViewId();
    const data = buildPaginationCallbackData(viewId, 3);
    expect(parsePaginationCallbackData(data)).toEqual({ viewId, page: 3 });
  });

  it("stays comfortably under the 64-byte Telegram callback_data limit", () => {
    const viewId = generateResultViewId();
    const data = buildPaginationCallbackData(viewId, 999);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

  it("never crashes on a malformed callback — returns null", () => {
    expect(parsePaginationCallbackData("")).toBeNull();
    expect(parsePaginationCallbackData("not-a-callback")).toBeNull();
    expect(parsePaginationCallbackData("pg:onlyone")).toBeNull();
    expect(parsePaginationCallbackData("pg::3")).toBeNull();
    expect(parsePaginationCallbackData("pg:abc:0")).toBeNull(); // page must be >= 1
    expect(parsePaginationCallbackData("pg:abc:-1")).toBeNull();
    expect(parsePaginationCallbackData("pg:abc:not-a-number")).toBeNull();
    expect(parsePaginationCallbackData("sh:2026-09-12")).toBeNull(); // wrong prefix
  });

  it("throws if a caller ever supplies a viewId long enough to exceed the limit (defense in depth)", () => {
    expect(() => buildPaginationCallbackData("x".repeat(100), 1)).toThrow();
  });

  it("generated result-view ids never contain the ':' delimiter", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateResultViewId()).not.toContain(":");
    }
  });
});
