/**
 * Injectable clock so business logic never calls `Date.now()`/`new Date()`
 * directly. Tests use a `FixedClock` to get deterministic, controllable time.
 *
 * See CLAUDE.md: "Core time-dependent logic receives a Clock."
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock whose time only moves when you tell it to. For tests. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Default clock for production code paths. */
export const systemClock: Clock = new SystemClock();
