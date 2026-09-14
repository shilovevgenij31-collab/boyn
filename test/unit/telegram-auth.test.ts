/**
 * Private-bot authorization (Phase 8 brief §7-8, §77).
 */
import { describe, expect, it } from "vitest";
import { isAdmin, isAuthorized, parseAdminId, parseAllowedUserIds } from "@/telegram/auth.ts";

describe("parseAllowedUserIds", () => {
  it("parses a comma-separated list", () => {
    expect(parseAllowedUserIds("111, 222,333")).toEqual(new Set([111, 222, 333]));
  });

  it("drops malformed entries rather than throwing", () => {
    expect(parseAllowedUserIds("111,abc,222,")).toEqual(new Set([111, 222]));
  });

  it("returns an empty set for undefined/empty", () => {
    expect(parseAllowedUserIds(undefined)).toEqual(new Set());
    expect(parseAllowedUserIds("")).toEqual(new Set());
  });
});

describe("parseAdminId", () => {
  it("parses a numeric id", () => {
    expect(parseAdminId("555")).toBe(555);
  });
  it("returns null for undefined/malformed", () => {
    expect(parseAdminId(undefined)).toBeNull();
    expect(parseAdminId("not-a-number")).toBeNull();
  });
});

describe("isAuthorized / isAdmin", () => {
  const config = { allowedUserIds: new Set([111, 222]), adminId: 999 };

  it("authorizes a listed normal user", () => {
    expect(isAuthorized(111, config)).toBe(true);
  });

  it("authorizes the admin even though not in the allow-list", () => {
    expect(isAuthorized(999, config)).toBe(true);
  });

  it("rejects an unlisted user — no data leak path", () => {
    expect(isAuthorized(12345, config)).toBe(false);
  });

  it("isAdmin is true only for the configured admin id", () => {
    expect(isAdmin(999, config)).toBe(true);
    expect(isAdmin(111, config)).toBe(false); // normal user is authorized but NOT admin
  });

  it("a normal user requesting an admin-only command is denied by isAdmin", () => {
    expect(isAuthorized(111, config)).toBe(true);
    expect(isAdmin(111, config)).toBe(false);
  });

  it("with no admin configured, isAdmin is always false", () => {
    expect(isAdmin(999, { allowedUserIds: new Set(), adminId: null })).toBe(false);
  });
});
