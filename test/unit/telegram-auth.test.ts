/**
 * Private-bot authorization (Phase 8 brief §7-8, §77; Phase 8/9 hotfix —
 * multi-admin support via TELEGRAM_ADMIN_USER_IDS alongside the legacy
 * ADMIN_TELEGRAM_ID).
 */
import { describe, expect, it } from "vitest";
import { isAdmin, isAuthorized, parseAdminId, parseAdminUserIds, parseAllowedUserIds, resolveAdminIds } from "@/telegram/auth.ts";

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

describe("parseAdminUserIds", () => {
  it("parses a comma-separated list, trimming whitespace", () => {
    expect(parseAdminUserIds(" 111 , 222,333 ")).toEqual(new Set([111, 222, 333]));
  });

  it("drops non-numeric entries rather than throwing", () => {
    expect(parseAdminUserIds("111,notanumber,222")).toEqual(new Set([111, 222]));
  });

  it("deduplicates repeated ids", () => {
    expect(parseAdminUserIds("111,111,222,111")).toEqual(new Set([111, 222]));
  });

  it("returns an empty set for undefined/empty", () => {
    expect(parseAdminUserIds(undefined)).toEqual(new Set());
    expect(parseAdminUserIds("")).toEqual(new Set());
  });
});

describe("resolveAdminIds", () => {
  it("with only the legacy ADMIN_TELEGRAM_ID set, that id is the sole admin", () => {
    expect(resolveAdminIds("999", undefined)).toEqual(new Set([999]));
  });

  it("with only TELEGRAM_ADMIN_USER_IDS set, those ids are admins", () => {
    expect(resolveAdminIds(undefined, "123456789,987654321")).toEqual(new Set([123456789, 987654321]));
  });

  it("unions both when both are configured — legacy admin is never dropped", () => {
    expect(resolveAdminIds("999", "111,222")).toEqual(new Set([999, 111, 222]));
  });

  it("is harmless when the legacy id also appears in the new list (duplicate)", () => {
    expect(resolveAdminIds("999", "999,111")).toEqual(new Set([999, 111]));
  });

  it("whitespace around ids in the new list is harmless", () => {
    expect(resolveAdminIds("999", " 111 , 222 ")).toEqual(new Set([999, 111, 222]));
  });

  it("returns an empty set when neither is configured", () => {
    expect(resolveAdminIds(undefined, undefined)).toEqual(new Set());
  });
});

describe("isAuthorized / isAdmin — single admin (legacy ADMIN_TELEGRAM_ID)", () => {
  const config = { allowedUserIds: new Set([111, 222]), adminIds: new Set([999]) };

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
    expect(isAdmin(999, { allowedUserIds: new Set(), adminIds: new Set() })).toBe(false);
  });
});

describe("isAuthorized / isAdmin — multi-admin", () => {
  const config = { allowedUserIds: new Set([111]), adminIds: resolveAdminIds("999", "555,777") };

  it("the original admin (legacy ADMIN_TELEGRAM_ID) still has full admin access", () => {
    expect(isAdmin(999, config)).toBe(true);
    expect(isAuthorized(999, config)).toBe(true);
  });

  it("a second admin added via TELEGRAM_ADMIN_USER_IDS has full admin access", () => {
    expect(isAdmin(555, config)).toBe(true);
    expect(isAuthorized(555, config)).toBe(true);
  });

  it("a third admin in the same list also works", () => {
    expect(isAdmin(777, config)).toBe(true);
  });

  it("every admin automatically has normal-user access without being in allowedUserIds", () => {
    expect(config.allowedUserIds.has(555)).toBe(false);
    expect(isAuthorized(555, config)).toBe(true);
  });

  it("a normal allowed user cannot use admin commands", () => {
    expect(isAuthorized(111, config)).toBe(true);
    expect(isAdmin(111, config)).toBe(false);
  });

  it("an unauthorized user cannot use admin commands", () => {
    expect(isAuthorized(424242, config)).toBe(false);
    expect(isAdmin(424242, config)).toBe(false);
  });
});
