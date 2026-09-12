import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../helpers/test-db.ts";
import { createCollectionRun, createProviderJob } from "@/db/repositories/runs.ts";
import { collectionRuns, providerJobs } from "@/db/schema.ts";

describe("runs repository", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("O: creating the same slot_key twice is idempotent, not a duplicate/conflict error", async () => {
    const params = { kind: "DISCOVERY" as const, slotKey: "2026-09-12T05:00Z-discovery", plannedAt: new Date() };
    const first = await createCollectionRun(db, params);
    const second = await createCollectionRun(db, params);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.id).toBe(second.id);

    const rows = await db.select().from(collectionRuns).where(eq(collectionRuns.slotKey, params.slotKey));
    expect(rows).toHaveLength(1);
  });

  it("a different slot_key creates a separate run", async () => {
    const a = await createCollectionRun(db, { kind: "REFRESH", slotKey: "slot-a", plannedAt: new Date() });
    const b = await createCollectionRun(db, { kind: "REFRESH", slotKey: "slot-b", plannedAt: new Date() });
    expect(a.id).not.toBe(b.id);
  });

  it("createProviderJob inserts a row tied to its collection run", async () => {
    const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: "slot-for-job", plannedAt: new Date() });
    const jobId = await createProviderJob(db, {
      collectionRunId: run.id,
      provider: "apify",
      platform: "tiktok",
      jobType: "HASHTAG_DISCOVERY",
      input: { queries: ["cosplay"] },
    });

    const [row] = await db.select().from(providerJobs).where(eq(providerJobs.id, jobId));
    expect(row?.collectionRunId).toBe(run.id);
    expect(row?.status).toBe("PENDING");
  });
});
