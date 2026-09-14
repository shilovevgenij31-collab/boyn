/**
 * HTML escaping for Telegram's `parse_mode: "HTML"` (Phase 8 brief §16-17).
 * Every piece of third-party text (captions, creator usernames, hashtags,
 * query names, error summaries) MUST go through `escapeHtml` before being
 * interpolated into a message — only renderer-generated markup is trusted
 * HTML. Telegram's HTML subset only requires escaping `&`, `<`, `>` in
 * text nodes; `escapeHtmlAttr` additionally escapes `"` for the one place
 * we build an attribute-like string ourselves (none currently — kept for
 * defense in depth / future `<a href>` use).
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Unicode-safe truncation to `maxChars` VISIBLE characters (brief §28) —
 * iterates by code point (`Array.from`), never splits a surrogate pair or
 * a combining-character cluster's base character from its own combining
 * marks in a way that would produce a lone unpaired surrogate. Truncation
 * happens BEFORE escaping so `maxChars` counts real characters, not
 * `&amp;`-expanded entity length.
 */
export function truncateUnicode(text: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  return { text: chars.slice(0, maxChars).join(""), truncated: true };
}
