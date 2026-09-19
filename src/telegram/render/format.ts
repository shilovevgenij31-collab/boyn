/**
 * Deterministic compact Russian formatting (Phase 8/9 production
 * hotfix §6-8: all user-facing bot text localized to Russian) — no
 * `Intl.NumberFormat`/locale-dependent behavior, so snapshots/tests stay
 * stable across environments; the Russian comma-decimal/unit-word style
 * is produced by hand, not by a locale formatter.
 */
import type { VelocityConfidence, VelocityKind } from "@/core/analytics/velocity.ts";

function trimTrailingZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function formatWithComma(n: number): string {
  return trimTrailingZero(n.toFixed(1)).replace(".", ",");
}

/** 999 -> "999", 1200 -> "1,2 тыс.", 12400 -> "12,4 тыс.", 2300000 -> "2,4 млн". */
export function formatCompactNumber(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${formatWithComma(abs / 1_000)} тыс.`;
  if (abs < 1_000_000_000) return `${sign}${formatWithComma(abs / 1_000_000)} млн`;
  return `${sign}${formatWithComma(abs / 1_000_000_000)} млрд`;
}

/** 42 мин / 3 ч 18 мин / 1 д 4 ч. */
export function formatAge(ageHours: number): string {
  const totalMinutes = Math.max(0, Math.round(ageHours * 60));
  if (totalMinutes < 60) return `${totalMinutes} мин`;

  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours} ч ${remMinutes} мин`;

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return `${days} д ${remHours} ч`;
}

const CONFIDENCE_BADGE: Record<"HIGH" | "MEDIUM" | "LOW", string> = { HIGH: "✅", MEDIUM: "◐", LOW: "◌" };

/** HIGH -> ✅, MEDIUM -> ◐, LOW/unavailable -> ◌ — a language-neutral
 * symbol, not translated text (brief §25/§7's "надёжность" label is used
 * only in the spelled-out metric-definitions text, not this compact
 * badge). */
export function confidenceBadge(confidence: VelocityConfidence): string {
  if (confidence === null) return "◌";
  return CONFIDENCE_BADGE[confidence];
}

/** "+138 тыс./ч ✅" (measured/observed) vs "~5,2 тыс./ч оцен. ◌"
 * (estimated) — visually distinguishes measured from estimated velocity
 * (brief §7's "измеренная скорость" / "оценочная скорость"), never
 * renders a missing vph as "0/ч". */
export function formatVph(vph: number | null, kind: VelocityKind, confidence: VelocityConfidence): string {
  if (vph === null || kind === "NONE") return "скорость неизвестна";
  const prefix = kind === "ESTIMATED" ? "~" : "+";
  const suffix = kind === "ESTIMATED" ? " оцен." : "";
  return `${prefix}${formatCompactNumber(vph)}/ч${suffix} ${confidenceBadge(confidence)}`;
}
