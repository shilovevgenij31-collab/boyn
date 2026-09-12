import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderName, PlatformName } from "./types.ts";

/** Saves up to `max` already-sanitized records as `test/fixtures/{provider}/
 * {platform}/{prefix}-N.json`. Distinct prefixes matter: reusing the same
 * numbering for two different kinds of saved record (e.g. discovery vs.
 * refresh) silently overwrites one with the other — that happened once in
 * Phase 1 and was fixed by giving refresh fixtures their own prefix. */
export async function saveFixtures(
  repoRoot: string,
  provider: ProviderName,
  platform: PlatformName,
  sanitizedRecords: unknown[],
  max = 5,
  prefix = "sample",
): Promise<number> {
  if (sanitizedRecords.length === 0) return 0;
  const dir = resolve(repoRoot, "test", "fixtures", provider, platform);
  await mkdir(dir, { recursive: true });
  const toSave = sanitizedRecords.slice(0, max);
  for (let i = 0; i < toSave.length; i++) {
    const path = resolve(dir, `${prefix}-${i + 1}.json`);
    await writeFile(path, JSON.stringify(toSave[i], null, 2) + "\n", "utf8");
  }
  return toSave.length;
}
