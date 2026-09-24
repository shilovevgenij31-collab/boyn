/**
 * Russian presentation for `DailyReport.partialReasons` (Phase 8/9
 * hotfix, production incident Part F). These raw codes
 * (`tiktok:discovery_failed`, `collection:budget_exhausted`, ...) are
 * generated in jobs/generate-daily-report.ts and jobs/run-daily.ts and
 * are meant as internal/exported diagnostics (export-markdown.ts keeps
 * them verbatim, deliberately — this module translates PRESENTATION
 * only, never the stored value).
 */
import { PLATFORM_LABEL } from "./labels.ts";

const FIXED_REASON_RU: Record<string, string> = {
  "collection:unfinished_jobs": "часть задач сбора ещё не завершена",
  "collection:budget_exhausted": "достигнут лимит бюджета на сбор данных",
  "analytics:failed": "не удалось полностью обновить аналитику",
};

const PLATFORM_SUFFIX_TEMPLATE_RU: Record<string, (platform: string) => string> = {
  discovery_failed: (platform) => `не удалось собрать свежие данные ${platform}`,
  discovery_partial: (platform) => `свежие данные ${platform} собраны частично`,
};

/** Never throws and never echoes an unrecognized raw code verbatim to the
 * user — an unknown reason still gets a safe, generic Russian sentence. */
export function translatePartialReason(reason: string): string {
  const fixed = FIXED_REASON_RU[reason];
  if (fixed) return fixed;

  const [prefix, suffix] = reason.split(":", 2);
  if (prefix && suffix && prefix in PLATFORM_LABEL && suffix in PLATFORM_SUFFIX_TEMPLATE_RU) {
    return PLATFORM_SUFFIX_TEMPLATE_RU[suffix]!(PLATFORM_LABEL[prefix as keyof typeof PLATFORM_LABEL]);
  }

  return "часть данных недоступна по внутренней причине";
}
