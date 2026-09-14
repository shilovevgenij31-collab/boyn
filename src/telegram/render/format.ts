/**
 * Deterministic compact formatting (Phase 8 brief §25-27) — no
 * `Intl.NumberFormat`/locale-dependent behavior, so snapshots/tests stay
 * stable across environments.
 */
import type { VelocityConfidence, VelocityKind } from "@/core/analytics/velocity.ts";

function trimTrailingZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** 999 -> "999", 1200 -> "1.2K", 12400 -> "12.4K", 2300000 -> "2.3M". */
export function formatCompactNumber(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${trimTrailingZero((abs / 1_000).toFixed(1))}K`;
  if (abs < 1_000_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  return `${sign}${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
}

/** 42m / 3h 18m / 1d 4h. */
export function formatAge(ageHours: number): string {
  const totalMinutes = Math.max(0, Math.round(ageHours * 60));
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${remMinutes}m`;

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return `${days}d ${remHours}h`;
}

const CONFIDENCE_BADGE: Record<"HIGH" | "MEDIUM" | "LOW", string> = { HIGH: "✅", MEDIUM: "◐", LOW: "◌" };

/** HIGH -> ✅, MEDIUM -> ◐, LOW/unavailable -> ◌ (brief §25). */
export function confidenceBadge(confidence: VelocityConfidence): string {
  if (confidence === null) return "◌";
  return CONFIDENCE_BADGE[confidence];
}

/** "+138K/h ✅" (observed) vs "~5.2K/h est. ◌" (estimated) — visually
 * distinguishes OBSERVED from ESTIMATED (brief §25), never renders a
 * missing vph as "0/h". */
export function formatVph(vph: number | null, kind: VelocityKind, confidence: VelocityConfidence): string {
  if (vph === null || kind === "NONE") return "vph unavailable";
  const prefix = kind === "ESTIMATED" ? "~" : "+";
  const suffix = kind === "ESTIMATED" ? " est." : "";
  return `${prefix}${formatCompactNumber(vph)}/h${suffix} ${confidenceBadge(confidence)}`;
}
