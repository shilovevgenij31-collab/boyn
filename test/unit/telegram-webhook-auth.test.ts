/**
 * Webhook secret verification (Phase 8 brief §9, §78).
 */
import { describe, expect, it } from "vitest";
import { checkWebhookAuth } from "@/telegram/webhook-auth.ts";

describe("checkWebhookAuth", () => {
  it("fails closed with 500 when no secret is configured", () => {
    const result = checkWebhookAuth("anything", undefined);
    expect(result).toEqual({ ok: false, status: 500, reason: expect.any(String) });
  });

  it("rejects a missing header with 401", () => {
    const result = checkWebhookAuth(null, "correct-secret");
    expect(result).toEqual({ ok: false, status: 401, reason: expect.any(String) });
  });

  it("rejects a wrong secret with 401", () => {
    const result = checkWebhookAuth("wrong-secret", "correct-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts the correct secret", () => {
    expect(checkWebhookAuth("correct-secret", "correct-secret")).toEqual({ ok: true });
  });

  it("never echoes the supplied secret in the failure reason", () => {
    const result = checkWebhookAuth("super-secret-value-xyz", "correct-secret");
    expect(!result.ok && result.reason).not.toContain("super-secret-value-xyz");
  });
});
