import type { Clock } from "./clock";
import { systemClock } from "./clock";

/**
 * Thrown by `Deadline.check()` once the budget has elapsed. Callers use this
 * to stop mid-loop work cleanly and leave the rest for the next scheduled
 * tick, rather than letting the host runtime hard-kill the function.
 */
export class DeadlineExceededError extends Error {
  readonly elapsedMs: number;
  readonly budgetMs: number;

  constructor(elapsedMs: number, budgetMs: number) {
    super(`Deadline exceeded: ${elapsedMs}ms elapsed, budget was ${budgetMs}ms`);
    this.name = "DeadlineExceededError";
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * A time budget for a unit of work (e.g. one cron tick). Vercel Hobby
 * functions are hard-killed at 300s; jobs call `deadline.check()` before
 * each expensive step so they can stop early and resume on the next tick
 * instead of being cut off mid-write. See docs/IMPLEMENTATION_PLAN.md §5, §10.
 */
export class Deadline {
  private readonly startedAtMs: number;
  private readonly budgetMs: number;
  private readonly clock: Clock;

  constructor(budgetMs: number, clock: Clock = systemClock) {
    if (budgetMs <= 0) {
      throw new RangeError("Deadline budgetMs must be positive");
    }
    this.budgetMs = budgetMs;
    this.clock = clock;
    this.startedAtMs = this.clock.now().getTime();
  }

  elapsedMs(): number {
    return this.clock.now().getTime() - this.startedAtMs;
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** Throws DeadlineExceededError if the budget has been used up. Call this
   * before starting the next unit of expensive work in a loop. */
  check(): void {
    if (this.isExpired()) {
      throw new DeadlineExceededError(this.elapsedMs(), this.budgetMs);
    }
  }
}
