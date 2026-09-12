import { describe, expect, it } from "vitest";
import { redactKnownSensitiveKeys, redactSecretValues, sanitize } from "../../scripts/provider-spike/sanitize.ts";

const TOKEN = "bd_live_ABCDEF1234567890secretvalue";

describe("redactKnownSensitiveKeys", () => {
  it("redacts common sensitive key names regardless of value", () => {
    const input = {
      Authorization: "Bearer whatever",
      api_key: "x",
      apiToken: "y",
      secret: "z",
      cookie: "session=abc",
      password: "hunter2",
      account_id: "acct_123",
      caption: "not sensitive",
    };
    const out = redactKnownSensitiveKeys(input) as Record<string, unknown>;
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.apiToken).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.account_id).toBe("[REDACTED]");
    expect(out.caption).toBe("not sensitive");
  });

  it("recurses into nested objects and arrays", () => {
    const input = { headers: { Authorization: "Bearer secret" }, items: [{ token: "abc" }] };
    const out = redactKnownSensitiveKeys(input) as {
      headers: { Authorization: string };
      items: [{ token: string }];
    };
    expect(out.headers.Authorization).toBe("[REDACTED]");
    expect(out.items[0].token).toBe("[REDACTED]");
  });
});

describe("redactSecretValues", () => {
  it("redacts an exact secret value appearing as a plain string field", () => {
    const out = redactSecretValues({ note: TOKEN }, [TOKEN]) as { note: string };
    expect(out.note).toBe("[REDACTED]");
    expect(out.note).not.toContain(TOKEN);
  });

  it("redacts a secret value embedded as a substring (e.g. inside a URL or header value)", () => {
    const input = { requestUrl: `https://api.example.com/x?token=${TOKEN}&format=json` };
    const out = redactSecretValues(input, [TOKEN]) as { requestUrl: string };
    expect(out.requestUrl).not.toContain(TOKEN);
    expect(out.requestUrl).toContain("[REDACTED]");
  });

  it("redacts a secret nested arbitrarily deep, under an innocuous-looking key", () => {
    const input = { debug: { extra: { blob: `prefix-${TOKEN}-suffix` } } };
    const out = redactSecretValues(input, [TOKEN]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("ignores secrets shorter than 6 characters (too generic to safely match)", () => {
    const out = redactSecretValues({ code: "ab12" }, ["ab12"]) as { code: string };
    expect(out.code).toBe("ab12");
  });

  it("is a no-op when no secrets are configured", () => {
    const input = { note: "hello world" };
    expect(redactSecretValues(input, [])).toEqual(input);
  });
});

describe("sanitize (combined)", () => {
  it("never leaks a configured token under ANY key name or nesting depth", () => {
    const input = {
      requestHeaders: { Authorization: `Bearer ${TOKEN}` },
      requestUrl: `https://api.brightdata.com/datasets/v3/trigger?token=${TOKEN}`,
      responseBody: { unrelatedField: `contains ${TOKEN} by accident` },
      deeply: { nested: { array: [{ x: TOKEN }] } },
    };
    const out = sanitize(input, [TOKEN]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TOKEN);
  });

  it("preserves non-sensitive public data untouched", () => {
    const input = { platform: "tiktok", views: 128000, hashtags: ["cosplay", "gaming"] };
    expect(sanitize(input, [TOKEN])).toEqual(input);
  });
});
