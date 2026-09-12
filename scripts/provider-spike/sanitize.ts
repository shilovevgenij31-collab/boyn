/**
 * Redaction utilities for anything captured during the provider spike
 * (HTTP request/response logs, saved fixtures, the results file). Two
 * independent layers, both applied:
 *
 *  1. Key-based: known-sensitive header/field names are redacted regardless
 *     of value (covers tokens we didn't even know to look for).
 *  2. Value-based: every configured secret value (API tokens) is redacted
 *     wherever it appears, even nested inside an unrelated-looking field.
 *
 * Pure functions — see test/unit/provider-spike-sanitize.test.ts, which
 * specifically proves a configured token cannot leak through this path.
 */

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[-_]?key|api[-_]?token|token|secret|cookie|set-cookie|password|account[-_]?id|billing)/i;

export function redactKnownSensitiveKeys<T>(value: T): T {
  return redactByKey(value) as T;
}

function redactByKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactByKey);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactByKey(val);
    }
    return out;
  }
  return value;
}

/** Redacts every occurrence of any given secret string, anywhere it appears
 * inside strings in the (already key-redacted) structure — including as a
 * substring of a longer string (e.g. an Authorization header value, a URL
 * query parameter). Secrets shorter than 6 chars are ignored as too generic
 * to safely pattern-match. */
export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
  const usable = secrets.filter((s) => s.length >= 6);
  if (usable.length === 0) return value;
  return redactValues(value, usable) as T;
}

function redactValues(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValues(v, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValues(val, secrets);
    }
    return out;
  }
  return value;
}

/** Applies both redaction layers, in the order that matters: key-based
 * first (removes whole known-sensitive fields), then value-based (catches
 * secrets leaking through fields we didn't think to name). */
export function sanitize<T>(value: T, secrets: readonly string[]): T {
  return redactSecretValues(redactKnownSensitiveKeys(value), secrets);
}
