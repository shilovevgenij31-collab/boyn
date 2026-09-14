/**
 * HTML escaping + Unicode-safe truncation (Phase 8 brief §17, §73).
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, escapeHtmlAttr, truncateUnicode } from "@/telegram/render/escape.ts";

describe("escapeHtml", () => {
  it("escapes &, <, >", () => {
    expect(escapeHtml("<b>bold</b> & <i>italic</i>")).toBe("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;");
  });

  it("neutralizes an HTML-looking caption so it can never inject formatting", () => {
    const caption = '<a href="evil">click</a><script>alert(1)</script>';
    const escaped = escapeHtml(caption);
    expect(escaped).not.toContain("<a ");
    expect(escaped).not.toContain("<script>");
  });

  it("leaves ampersands, quotes, emoji, Cyrillic, Japanese, combining marks intact except & < >", () => {
    const text = "Café & 日本語 — cosplay 🎉 é Кириллица \"quoted\"";
    const escaped = escapeHtml(text);
    expect(escaped).toContain("日本語");
    expect(escaped).toContain("🎉");
    expect(escaped).toContain("Кириллица");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain('"quoted"'); // quotes untouched by escapeHtml (not an attribute context)
  });

  it("handles a very long string without throwing", () => {
    const long = "a<b>&".repeat(10_000);
    expect(() => escapeHtml(long)).not.toThrow();
    expect(escapeHtml(long).length).toBeGreaterThan(long.length);
  });
});

describe("escapeHtmlAttr", () => {
  it("additionally escapes double quotes", () => {
    expect(escapeHtmlAttr('say "hi" <now>')).toBe("say &quot;hi&quot; &lt;now&gt;");
  });
});

describe("truncateUnicode", () => {
  it("does not truncate a short string", () => {
    expect(truncateUnicode("hello", 120)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates a long string at the character boundary", () => {
    const result = truncateUnicode("a".repeat(200), 120);
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text)).toHaveLength(120);
  });

  it("never splits a surrogate pair (emoji)", () => {
    const emoji = "😀"; // one code point, two UTF-16 code units
    const text = emoji.repeat(130);
    const result = truncateUnicode(text, 120);
    expect(result.truncated).toBe(true);
    // Every char in the truncated text must be a complete emoji, never a lone surrogate.
    expect([...result.text].every((c) => c === emoji)).toBe(true);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no unpaired high surrogate
  });

  it("handles combining characters without producing invalid output", () => {
    const combining = "é"; // é as e + combining acute accent
    const text = combining.repeat(150);
    const result = truncateUnicode(text, 120);
    expect(() => escapeHtml(result.text)).not.toThrow();
  });
});
