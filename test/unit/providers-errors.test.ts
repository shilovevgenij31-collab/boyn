import { describe, expect, it } from "vitest";
import { isCircuitEligibleFailure, isProviderError, ProviderError } from "@/providers/errors.ts";

describe("ProviderError defaults", () => {
  it("defaults RATE_LIMIT/UPSTREAM/TIMEOUT to retryable", () => {
    expect(new ProviderError("RATE_LIMIT", "p", "op", "m").retryable).toBe(true);
    expect(new ProviderError("UPSTREAM", "p", "op", "m").retryable).toBe(true);
    expect(new ProviderError("TIMEOUT", "p", "op", "m").retryable).toBe(true);
  });

  it("defaults AUTH/QUOTA/BAD_INPUT/NOT_FOUND/UNSUPPORTED to non-retryable", () => {
    for (const code of ["AUTH", "QUOTA", "BAD_INPUT", "NOT_FOUND", "UNSUPPORTED"] as const) {
      expect(new ProviderError(code, "p", "op", "m").retryable).toBe(false);
    }
  });

  it("never includes a cause's message directly — isProviderError distinguishes it from a plain Error", () => {
    expect(isProviderError(new ProviderError("UPSTREAM", "p", "op", "m"))).toBe(true);
    expect(isProviderError(new Error("plain"))).toBe(false);
  });
});

describe("isCircuitEligibleFailure", () => {
  it("UPSTREAM/TIMEOUT/RATE_LIMIT are eligible (count toward opening the circuit)", () => {
    expect(isCircuitEligibleFailure(new ProviderError("UPSTREAM", "p", "op", "m"))).toBe(true);
    expect(isCircuitEligibleFailure(new ProviderError("TIMEOUT", "p", "op", "m"))).toBe(true);
    expect(isCircuitEligibleFailure(new ProviderError("RATE_LIMIT", "p", "op", "m"))).toBe(true);
  });

  it("BAD_INPUT/AUTH/QUOTA/UNSUPPORTED/NOT_FOUND are NOT eligible", () => {
    for (const code of ["BAD_INPUT", "AUTH", "QUOTA", "UNSUPPORTED", "NOT_FOUND"] as const) {
      expect(isCircuitEligibleFailure(new ProviderError(code, "p", "op", "m"))).toBe(false);
    }
  });

  it("an unrecognized (non-ProviderError) failure is treated conservatively as eligible", () => {
    expect(isCircuitEligibleFailure(new Error("some unexpected crash"))).toBe(true);
  });
});
