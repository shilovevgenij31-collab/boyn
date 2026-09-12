import { describe, expect, it } from "vitest";
import { AppError, errorStatusCode, isAppError, toErrorResponse } from "@/lib/errors";

describe("AppError / toErrorResponse / errorStatusCode", () => {
  it("isAppError distinguishes AppError from a plain Error", () => {
    expect(isAppError(new AppError("VALIDATION", "bad input"))).toBe(true);
    expect(isAppError(new Error("boom"))).toBe(false);
    expect(isAppError("not even an error")).toBe(false);
  });

  it("toErrorResponse exposes code and message for a known AppError", () => {
    const error = new AppError("NOT_FOUND", "post not found");
    expect(toErrorResponse(error)).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "post not found" },
    });
  });

  it("toErrorResponse never leaks details of an unknown error", () => {
    const error = new TypeError("some internal secret detail");
    const response = toErrorResponse(error);
    expect(response).toEqual({ ok: false, error: { code: "INTERNAL", message: "Internal error" } });
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("errorStatusCode maps every AppErrorCode to a sensible HTTP status", () => {
    expect(errorStatusCode(new AppError("VALIDATION", "x"))).toBe(400);
    expect(errorStatusCode(new AppError("UNAUTHORIZED", "x"))).toBe(401);
    expect(errorStatusCode(new AppError("NOT_FOUND", "x"))).toBe(404);
    expect(errorStatusCode(new AppError("CONFLICT", "x"))).toBe(409);
    expect(errorStatusCode(new AppError("TIMEOUT", "x"))).toBe(408);
    expect(errorStatusCode(new AppError("RATE_LIMIT", "x"))).toBe(429);
    expect(errorStatusCode(new AppError("UPSTREAM", "x"))).toBe(502);
    expect(errorStatusCode(new AppError("INTERNAL", "x"))).toBe(500);
  });

  it("errorStatusCode defaults unknown errors to 500", () => {
    expect(errorStatusCode(new Error("boom"))).toBe(500);
  });

  it("preserves the cause chain for debugging", () => {
    const cause = new Error("root cause");
    const error = new AppError("UPSTREAM", "provider failed", { cause });
    expect(error.cause).toBe(cause);
  });
});
