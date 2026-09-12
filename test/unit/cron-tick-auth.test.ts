import { describe, expect, it } from "vitest";
import { checkCronAuth } from "@/app/api/cron/tick/auth.ts";

describe("checkCronAuth", () => {
  it("fails closed when CRON_SECRET is not configured, even with a plausible header", () => {
    const result = checkCronAuth("Bearer anything", undefined);
    expect(result).toEqual({ ok: false, status: 500, reason: "CRON_SECRET is not configured" });
  });

  it("rejects an incorrect secret with 401", () => {
    const result = checkCronAuth("Bearer wrong-secret", "correct-secret");
    expect(result).toEqual({ ok: false, status: 401, reason: "invalid or missing Authorization header" });
  });

  it("rejects a missing Authorization header with 401", () => {
    const result = checkCronAuth(null, "correct-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts the exact configured secret as a Bearer token", () => {
    expect(checkCronAuth("Bearer correct-secret", "correct-secret")).toEqual({ ok: true });
  });

  it("rejects a header missing the 'Bearer ' prefix even if the token matches", () => {
    const result = checkCronAuth("correct-secret", "correct-secret");
    expect(result.ok).toBe(false);
  });
});
