import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";

describe("logger", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.LOG_LEVEL = originalLogLevel;
  });

  it("writes a single JSON line with level, msg and timestamp", () => {
    process.env.LOG_LEVEL = "debug";
    logger.info("hello", { runId: "run-1", count: 3 });

    expect(console.log).toHaveBeenCalledTimes(1);
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0];
    const line = call?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.count).toBe(3);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("routes warn/error to console.warn/console.error", () => {
    process.env.LOG_LEVEL = "debug";
    logger.warn("careful");
    logger.error("boom");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("suppresses levels below the configured LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    logger.debug("should not appear");
    logger.info("should not appear either");
    logger.warn("this one should appear");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to info level for an unset/invalid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "not-a-level";
    logger.debug("suppressed");
    logger.info("shown");
    expect(console.log).toHaveBeenCalledTimes(1);
  });
});
