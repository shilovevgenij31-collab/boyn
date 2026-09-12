import { describe, expect, it } from "vitest";
import { FixedClock } from "@/lib/clock";
import { Deadline, DeadlineExceededError } from "@/lib/deadline";

describe("Deadline", () => {
  it("is not expired before the budget elapses", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    const deadline = new Deadline(1000, clock);
    clock.advanceMs(999);
    expect(deadline.isExpired()).toBe(false);
    expect(() => deadline.check()).not.toThrow();
  });

  it("is expired exactly at and after the budget", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    const deadline = new Deadline(1000, clock);
    clock.advanceMs(1000);
    expect(deadline.isExpired()).toBe(true);
    clock.advanceMs(500);
    expect(deadline.isExpired()).toBe(true);
  });

  it("check() throws DeadlineExceededError with elapsed/budget once expired", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    const deadline = new Deadline(1000, clock);
    clock.advanceMs(1200);
    expect(() => deadline.check()).toThrow(DeadlineExceededError);
    try {
      deadline.check();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeadlineExceededError);
      const deadlineError = error as DeadlineExceededError;
      expect(deadlineError.elapsedMs).toBe(1200);
      expect(deadlineError.budgetMs).toBe(1000);
    }
  });

  it("remainingMs never goes negative", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    const deadline = new Deadline(1000, clock);
    clock.advanceMs(5000);
    expect(deadline.remainingMs()).toBe(0);
  });

  it("remainingMs counts down correctly before expiry", () => {
    const clock = new FixedClock(new Date("2026-09-12T00:00:00.000Z"));
    const deadline = new Deadline(1000, clock);
    clock.advanceMs(400);
    expect(deadline.remainingMs()).toBe(600);
  });

  it("rejects a non-positive budget", () => {
    expect(() => new Deadline(0)).toThrow(RangeError);
    expect(() => new Deadline(-5)).toThrow(RangeError);
  });
});
