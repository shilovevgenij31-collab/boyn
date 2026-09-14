/**
 * Report-date derivation (Phase 7 brief §5): the calendar date a report
 * belongs to is the generation instant's date IN `REPORT_TZ`, not UTC —
 * pure and deterministic given an explicit instant, no `Date.now()`.
 * `Intl.DateTimeFormat`'s `en-CA` locale is used only because it happens
 * to format as `YYYY-MM-DD` — no locale-specific behavior is intended.
 */
export function formatReportDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
