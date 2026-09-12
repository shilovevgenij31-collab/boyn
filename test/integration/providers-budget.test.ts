/**
 * Proves the budget ledger is computed from REAL persisted provider_jobs
 * rows (PGlite), not a second in-memory counter (Phase 4 brief §19-21).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDatabase } from "./helpers/test-db.ts";
import { createCollectionRun } from "@/db/repositories/runs.ts";
import { providerJobs } from "@/db/schema.ts";
import { canSubmit, canSubmitToProvider, getBudgetStatus } from "@/providers/budget.ts";
import { BUDGET_PROFILES } from "@/config/budget.ts";

const NOW = new Date("2026-09-12T18:00:00.000Z");

async function insertJob(
  db: TestDatabase,
  collectionRunId: number,
  params: {
    provider: "apify" | "brightdata";
    submittedAt: Date;
    recordsReturned: number;
    costEstUsd: string;
  },
): Promise<void> {
  await db.insert(providerJobs).values({
    collectionRunId,
    provider: params.provider,
    platform: "tiktok",
    jobType: "HASHTAG_DISCOVERY",
    status: "READY",
    submittedAt: params.submittedAt,
    recordsReturned: params.recordsReturned,
    costEstUsd: params.costEstUsd,
  });
}

describe("provider budget ledger (PGlite-backed)", () => {
  let db: TestDatabase;
  let close: () => Promise<void>;
  let runId: number;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  beforeEach(async () => {
    // Each test needs a clean ledger — getProviderUsageSince sums across
    // the whole table, so leftover rows from a prior test would silently
    // inflate totals here.
    await db.delete(providerJobs);
    const run = await createCollectionRun(db, {
      kind: "DISCOVERY",
      slotKey: `test-slot-${Math.random()}`,
      plannedAt: NOW,
    });
    runId = run.id;
  });

  it("sums exactly across multiple jobs with no float drift", async () => {
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 10, costEstUsd: "0.10" });
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 15, costEstUsd: "0.20" });
    await insertJob(db, runId, { provider: "brightdata", submittedAt: NOW, recordsReturned: 5, costEstUsd: "0.05" });

    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.usedToday).toBe(30);
    expect(status.estimatedUsdMonth).toBeCloseTo(0.35, 10);
  });

  it("excludes jobs submitted before the start of the current UTC day from usedToday but includes them in the month", async () => {
    const yesterday = new Date("2026-09-11T10:00:00.000Z");
    await insertJob(db, runId, { provider: "apify", submittedAt: yesterday, recordsReturned: 40, costEstUsd: "1.00" });
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 5, costEstUsd: "0.10" });

    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.usedToday).toBe(5);
    expect(status.usedThisMonth).toBe(45);
  });

  it("excludes jobs never actually submitted (null submittedAt)", async () => {
    await db.insert(providerJobs).values({
      collectionRunId: runId,
      provider: "apify",
      platform: "tiktok",
      jobType: "HASHTAG_DISCOVERY",
      status: "PENDING",
      recordsReturned: 999,
      costEstUsd: "99.00",
    });
    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.usedToday).toBe(0);
    expect(status.estimatedUsdMonth).toBe(0);
  });

  it("enforces the hard monthly USD ceiling: canSubmit is false once monthlyUsdMax is reached", async () => {
    // LEAN profile: monthlyUsdMax = 10
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 10, costEstUsd: "10.00" });
    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.monthlyUsdExceeded).toBe(true);
    expect(canSubmit(status)).toBe(false);
  });

  it("enforces the daily record limit independently of dollar cost", async () => {
    // LEAN profile: dailyRecordLimit = 360
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 360, costEstUsd: "0.01" });
    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.dailyRecordsExceeded).toBe(true);
    expect(canSubmit(status)).toBe(false);
  });

  it("enforces the per-provider Apify sub-cap without blocking Bright Data", async () => {
    // LEAN profile: apifyMonthlyUsdMax = 4.5
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 10, costEstUsd: "4.50" });
    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status.apifyMonthlyUsdExceeded).toBe(true);
    expect(canSubmit(status)).toBe(true);
    expect(canSubmitToProvider(status, "apify")).toBe(false);
    expect(canSubmitToProvider(status, "brightdata")).toBe(true);
  });

  it("LEAN's default profile ceiling is exactly the hard $10/month cap", () => {
    expect(BUDGET_PROFILES.LEAN.monthlyUsdMax).toBe(10);
  });

  it("a BUDGET_MONTHLY_USD_MAX override enforces a hard ceiling even under the STANDARD profile's higher default", async () => {
    await insertJob(db, runId, { provider: "apify", submittedAt: NOW, recordsReturned: 10, costEstUsd: "12.00" });
    const uncapped = await getBudgetStatus(db, NOW, "STANDARD");
    expect(uncapped.monthlyUsdExceeded).toBe(false); // STANDARD's own default max is 40

    const capped = await getBudgetStatus(db, NOW, "STANDARD", { monthlyUsdMax: 10 });
    expect(capped.estimatedUsdMonth).toBeCloseTo(12, 10);
    expect(capped.monthlyUsdExceeded).toBe(true);
    expect(canSubmit(capped)).toBe(false);
  });

  it("with no jobs at all, usage is exactly zero and nothing is exceeded", async () => {
    const status = await getBudgetStatus(db, NOW, "LEAN");
    expect(status).toMatchObject({
      usedToday: 0,
      usedThisMonth: 0,
      estimatedUsdMonth: 0,
      apifyUsdMonth: 0,
      dailyRecordsExceeded: false,
      monthlyUsdExceeded: false,
      apifyMonthlyUsdExceeded: false,
    });
    expect(canSubmit(status)).toBe(true);
  });
});
