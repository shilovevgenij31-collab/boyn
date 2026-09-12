import { describe, expect, it } from "vitest";
import { normalizeQueryTerm, normalizeQueryTerms } from "@/core/normalize/query.ts";

describe("normalizeQueryTerm", () => {
  it("strips a leading # and lowercases", () => {
    expect(normalizeQueryTerm("#Cosplay")).toBe("cosplay");
    expect(normalizeQueryTerm("GAMING")).toBe("gaming");
  });

  it("treats '#gaming' and 'gaming' as the same term", () => {
    expect(normalizeQueryTerm("#gaming")).toBe(normalizeQueryTerm("gaming"));
  });

  it("preserves Unicode terms", () => {
    expect(normalizeQueryTerm("#косплей")).toBe("косплей");
  });

  it("rejects empty/invalid terms", () => {
    expect(normalizeQueryTerm("#")).toBeNull();
    expect(normalizeQueryTerm("")).toBeNull();
    expect(normalizeQueryTerm("two words")).toBeNull();
  });
});

describe("normalizeQueryTerms", () => {
  it("deduplicates terms that normalize to the same value", () => {
    expect(normalizeQueryTerms(["#cosplay", "cosplay", "Cosplay"])).toEqual(["cosplay"]);
  });

  it("drops invalid terms without failing the batch", () => {
    expect(normalizeQueryTerms(["cosplay", "", "gaming"])).toEqual(["cosplay", "gaming"]);
  });

  it("preserves first-seen order", () => {
    expect(normalizeQueryTerms(["ps5", "cosplay", "gaming"])).toEqual(["ps5", "cosplay", "gaming"]);
  });
});
