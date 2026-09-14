import { describe, expect, it } from "vitest";
import { confidenceBadge, formatAge, formatCompactNumber, formatVph } from "@/telegram/render/format.ts";

describe("formatCompactNumber", () => {
  it("renders sub-1000 numbers plainly", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(0)).toBe("0");
  });

  it("renders thousands with one decimal", () => {
    expect(formatCompactNumber(1200)).toBe("1.2K");
    expect(formatCompactNumber(12_400)).toBe("12.4K");
    expect(formatCompactNumber(1000)).toBe("1K");
  });

  it("renders millions with one decimal", () => {
    expect(formatCompactNumber(2_300_000)).toBe("2.3M");
  });

  it("is deterministic across repeated calls (no locale dependence)", () => {
    const results = new Set(Array.from({ length: 5 }, () => formatCompactNumber(12_345)));
    expect(results.size).toBe(1);
  });
});

describe("formatAge", () => {
  it("renders minutes under an hour", () => {
    expect(formatAge(42 / 60)).toBe("42m");
  });

  it("renders hours and minutes", () => {
    expect(formatAge(3 + 18 / 60)).toBe("3h 18m");
  });

  it("renders days and hours at 24h+", () => {
    expect(formatAge(28)).toBe("1d 4h");
  });

  it("never goes negative", () => {
    expect(formatAge(-1)).toBe("0m");
  });
});

describe("confidenceBadge", () => {
  it("maps HIGH/MEDIUM/LOW/null", () => {
    expect(confidenceBadge("HIGH")).toBe("✅");
    expect(confidenceBadge("MEDIUM")).toBe("◐");
    expect(confidenceBadge("LOW")).toBe("◌");
    expect(confidenceBadge(null)).toBe("◌");
  });
});

describe("formatVph", () => {
  it("never renders a missing vph as 0/h", () => {
    const text = formatVph(null, "NONE", null);
    expect(text).not.toContain("0/h");
    expect(text).toContain("unavailable");
  });

  it("distinguishes OBSERVED from ESTIMATED", () => {
    const observed = formatVph(138_000, "OBSERVED", "HIGH");
    const estimated = formatVph(5_200, "ESTIMATED", "LOW");
    expect(observed).toContain("+");
    expect(observed).not.toContain("est.");
    expect(estimated).toContain("~");
    expect(estimated).toContain("est.");
  });
});
