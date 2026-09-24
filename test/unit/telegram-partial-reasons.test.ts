/**
 * Russian presentation of DailyReport.partialReasons (Phase 8/9 hotfix
 * Part F: production evidence showed raw codes like "tiktok:discovery_
 * failed" leaking straight into the user-facing /today header).
 */
import { describe, expect, it } from "vitest";
import { translatePartialReason } from "@/telegram/render/partial-reasons.ts";

describe("translatePartialReason", () => {
  it("translates the exact codes named in the production incident", () => {
    expect(translatePartialReason("tiktok:discovery_failed")).toBe("не удалось собрать свежие данные TikTok");
    expect(translatePartialReason("instagram:discovery_failed")).toBe("не удалось собрать свежие данные Instagram");
    expect(translatePartialReason("collection:unfinished_jobs")).toBe("часть задач сбора ещё не завершена");
    expect(translatePartialReason("collection:budget_exhausted")).toBe("достигнут лимит бюджета на сбор данных");
    expect(translatePartialReason("analytics:failed")).toBe("не удалось полностью обновить аналитику");
  });

  it("translates the partial (not fully failed) discovery variant per platform", () => {
    expect(translatePartialReason("tiktok:discovery_partial")).toContain("TikTok");
    expect(translatePartialReason("instagram:discovery_partial")).toContain("Instagram");
  });

  it("never echoes an unrecognized raw code verbatim — falls back to a safe generic Russian sentence", () => {
    const result = translatePartialReason("some:unknown_future_code");
    expect(result).not.toContain("some:unknown_future_code");
    expect(result).not.toMatch(/[a-z_]+:[a-z_]+/); // no leftover machine-code shape
  });

  it("every translated string is plain Russian text, never containing a literal colon-separated code", () => {
    const codes = ["tiktok:discovery_failed", "instagram:discovery_failed", "collection:unfinished_jobs", "collection:budget_exhausted", "analytics:failed"];
    for (const code of codes) {
      expect(translatePartialReason(code)).not.toContain(":");
    }
  });
});
