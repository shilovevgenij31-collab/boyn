import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads a real sanitized fixture captured during Phase 1 / 1B — path is
 * relative to test/fixtures/, e.g. "apify/tiktok/sample-1.json". Offline
 * only: reads a committed file, never touches the network. */
export function loadFixture(relativePath: string): unknown {
  const fixturesRoot = fileURLToPath(new URL("../../fixtures/", import.meta.url));
  const content = readFileSync(fixturesRoot + relativePath, "utf8");
  return JSON.parse(content);
}
