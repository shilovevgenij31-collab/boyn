import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.ts";

describe("migrations", () => {
  it("apply cleanly to a fresh PGlite database", async () => {
    const { db, close } = await createTestDb();
    try {
      const result = await db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const tableNames = result.rows.map((r) => r.table_name);
      expect(tableNames).toContain("posts");
      expect(tableNames).toContain("post_snapshots");
      expect(tableNames).toContain("hashtags");
      expect(tableNames).toContain("tracked_hashtags");
      expect(tableNames).toContain("telegram_users");
      expect(tableNames.length).toBe(22);
    } finally {
      await close();
    }
  });
});
