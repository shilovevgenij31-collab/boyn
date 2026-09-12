/**
 * Hashtag extraction/normalization, merged from two sources per real
 * fixture evidence:
 *   - Apify TikTok's `hashtags` field is an array of OBJECTS
 *     (`{ id, name, title?, cover? }`) — only `.name` is usable.
 *   - Bright Data TikTok's and Apify Instagram's `hashtags` fields are
 *     plain string arrays.
 *   - Captions also carry inline `#tag` text worth capturing even when a
 *     provider's own hashtags array under-reports (observed: Bright Data
 *     TikTok samples with hashtags present but a couple of caption-only
 *     tags not echoed back in the structured field).
 *
 * A single malformed hashtag entry is silently dropped, not a
 * normalization failure — see CLAUDE.md rule 8 / social-post.ts's failure
 * kinds, which reserve real failures for identity/link problems, not tag
 * noise.
 */

const MAX_HASHTAG_LENGTH = 100;
// Unicode letters, numbers, and underscore — explicitly NOT ASCII-only, so
// Cyrillic/CJK/etc. tags are preserved (Phase 1 fixtures included Cyrillic
// and Japanese hashtags).
const VALID_HASHTAG_PATTERN = /^[\p{L}\p{N}_]+$/u;
const CAPTION_HASHTAG_PATTERN = /#([\p{L}\p{N}_]+)/gu;

/** Accepts either shape observed across providers and returns plain name
 * strings, still unnormalized (caller runs them through normalizeHashtagToken). */
export function extractRawHashtagNames(rawHashtags: unknown): string[] {
  if (!Array.isArray(rawHashtags)) return [];
  const names: string[] = [];
  for (const entry of rawHashtags) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
      names.push((entry as { name: string }).name);
    }
    // Anything else (null, malformed entry) is silently skipped.
  }
  return names;
}

/** Strips a leading "#", Unicode-normalizes (NFKC), lowercases, and
 * validates. Returns null (excluded, not an error) for anything empty,
 * oversized, or containing characters outside letters/numbers/underscore
 * after stripping — e.g. a stray "#" alone, or a caption artifact with
 * punctuation swept in by a loose extraction elsewhere. */
export function normalizeHashtagToken(raw: string): string | null {
  let token = raw.trim();
  if (token.startsWith("#")) token = token.slice(1);
  token = token.normalize("NFKC").trim().toLowerCase();
  if (token.length === 0 || token.length > MAX_HASHTAG_LENGTH) return null;
  if (!VALID_HASHTAG_PATTERN.test(token)) return null;
  return token;
}

export function extractHashtagsFromCaption(caption: string | null): string[] {
  if (!caption) return [];
  const matches = caption.matchAll(CAPTION_HASHTAG_PATTERN);
  return [...matches].map((m) => m[1]!);
}

/** Normalizes, validates, and deduplicates (first-seen order preserved)
 * across any number of raw-name arrays. */
export function mergeHashtags(...sources: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    for (const raw of source) {
      const normalized = normalizeHashtagToken(raw);
      if (normalized !== null && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  return result;
}
