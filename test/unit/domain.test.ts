import { describe, expect, it } from "vitest";
import { isPlatform, PLATFORMS } from "@/core/domain/platform";
import { GLOBAL_MARKET, isValidMarket } from "@/core/domain/market";
import { CATEGORIES, CATEGORY_PARENTS, isCategory } from "@/core/domain/category";

describe("Platform", () => {
  it("recognises exactly tiktok and instagram", () => {
    expect(PLATFORMS).toEqual(["tiktok", "instagram"]);
    expect(isPlatform("tiktok")).toBe(true);
    expect(isPlatform("instagram")).toBe(true);
    expect(isPlatform("youtube")).toBe(false);
    expect(isPlatform("")).toBe(false);
  });
});

describe("Market", () => {
  it("treats 'global' as a valid, real market", () => {
    expect(isValidMarket(GLOBAL_MARKET)).toBe(true);
  });

  it("accepts lowercase alphanumeric market ids", () => {
    expect(isValidMarket("us")).toBe(true);
    expect(isValidMarket("ru")).toBe(true);
    expect(isValidMarket("us-west")).toBe(true);
  });

  it("rejects malformed market ids", () => {
    expect(isValidMarket("")).toBe(false);
    expect(isValidMarket("US")).toBe(false); // must be lowercase
    expect(isValidMarket("1us")).toBe(false); // must start with a letter
    expect(isValidMarket("has space")).toBe(false);
  });
});

describe("Category", () => {
  it("recognises the five approved seed categories", () => {
    expect(CATEGORIES).toEqual(["cosplay", "streaming", "gaming", "pc", "playstation"]);
    for (const category of CATEGORIES) {
      expect(isCategory(category)).toBe(true);
    }
    expect(isCategory("cooking")).toBe(false);
  });

  it("rolls pc and playstation up into gaming", () => {
    expect(CATEGORY_PARENTS.pc).toBe("gaming");
    expect(CATEGORY_PARENTS.playstation).toBe("gaming");
    expect(CATEGORY_PARENTS.cosplay).toBeUndefined();
    expect(CATEGORY_PARENTS.streaming).toBeUndefined();
  });
});
