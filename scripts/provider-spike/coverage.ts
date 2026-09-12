/**
 * Field-presence coverage over a sample of raw provider records. A field
 * counts as "present" only if it resolves to a non-null, non-undefined,
 * non-empty-string value — never coerced from absent to a fake default.
 * See CLAUDE.md rule 8.
 */

export interface FieldCoverage {
  field: string;
  present: number;
  total: number;
  pct: number;
}

/** `field` may be a dotted path (e.g. "author.followerCount") into each record. */
function getPath(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

export function computeFieldCoverage(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): FieldCoverage[] {
  const total = records.length;
  return fields.map((field) => {
    const present = records.filter((r) => isPresent(getPath(r, field))).length;
    return {
      field,
      present,
      total,
      pct: total === 0 ? 0 : Math.round((present / total) * 1000) / 10,
    };
  });
}
