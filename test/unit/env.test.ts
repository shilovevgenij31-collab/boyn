import { describe, expect, it } from "vitest";
import { loadEnv } from "@/config/env";

describe("loadEnv", () => {
  it("boots with zero variables set (Phase 0: no future secrets required)", () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DEFAULT_MARKET).toBe("global");
    expect(env.BUDGET_PROFILE).toBe("LEAN");
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("accepts a fully-populated valid environment", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      APP_BASE_URL: "https://trend-radar.example.com",
      DATABASE_URL: "postgres://user:pass@host/db",
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_WEBHOOK_SECRET: "abc123_XYZ-9",
      ADMIN_TELEGRAM_ID: "123456789",
      PROVIDER_TIKTOK_PRIMARY: "brightdata",
      PROVIDER_TIKTOK_FALLBACK: "apify",
      PROVIDER_COUNTRY: "US",
      DEFAULT_MARKET: "global",
      BUDGET_PROFILE: "STANDARD",
      BUDGET_MONTHLY_USD_MAX: "40",
      REPORT_LOCAL_TIME: "09:00",
      AI_TIMEOUT_MS: "45000",
    });
    expect(env.ADMIN_TELEGRAM_ID).toBe("123456789");
    expect(env.PROVIDER_TIKTOK_PRIMARY).toBe("brightdata");
    expect(env.BUDGET_PROFILE).toBe("STANDARD");
  });

  it("rejects a malformed value even though the variable is optional", () => {
    expect(() => loadEnv({ ADMIN_TELEGRAM_ID: "not-a-number" })).toThrow(/ADMIN_TELEGRAM_ID/);
  });

  it("rejects an invalid enum value", () => {
    expect(() => loadEnv({ BUDGET_PROFILE: "ULTRA" })).toThrow(/BUDGET_PROFILE/);
  });

  it("rejects a malformed report time", () => {
    expect(() => loadEnv({ REPORT_LOCAL_TIME: "9am" })).toThrow(/REPORT_LOCAL_TIME/);
  });

  it("rejects a malformed APP_BASE_URL", () => {
    expect(() => loadEnv({ APP_BASE_URL: "not a url" })).toThrow(/APP_BASE_URL/);
  });

  it("reports every problem at once, not just the first", () => {
    try {
      loadEnv({ ADMIN_TELEGRAM_ID: "nope", BUDGET_PROFILE: "ULTRA" });
      expect.unreachable("loadEnv should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("ADMIN_TELEGRAM_ID");
      expect(message).toContain("BUDGET_PROFILE");
    }
  });
});
