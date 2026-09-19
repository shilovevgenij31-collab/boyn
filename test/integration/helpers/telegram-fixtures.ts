/**
 * Shared seed/context helpers for Phase 8 Telegram integration tests —
 * PGlite-backed, no network. Builds a real TelegramCommandContext (with a
 * RecordingTelegramClient) and a small, realistic dataset (posts, tracked
 * hashtags, a frozen DailyReport) that every router/webhook/delivery test
 * can reuse instead of re-deriving from scratch.
 */
import type { TestDatabase } from "./test-db.ts";
import { FixedClock } from "@/lib/clock.ts";
import { GLOBAL_MARKET } from "@/core/domain/market.ts";
import { ProviderRegistry, DEFAULT_REGISTRY_CONFIG } from "@/providers/registry.ts";
import { CircuitBreaker } from "@/providers/circuit-breaker.ts";
import { DbCircuitBreakerStore } from "@/providers/db-circuit-breaker-store.ts";
import { FixtureProvider } from "@/providers/fixture/provider.ts";
import type { RuntimeProviderId, SocialDataProvider } from "@/providers/provider.ts";
import type { TelegramCommandContext } from "@/telegram/context.ts";
import { createRecordingTelegramClient, type RecordingTelegramClient } from "../../helpers/recording-telegram-client.ts";
import {
  posts,
  providerJobs,
  collectionRuns,
  hashtags,
  trackedHashtags,
  postHashtags,
  postCategories,
  postSnapshots,
  postDiscoveries,
  dailyReports,
  resultViews,
  telegramUpdates,
  hashtagTierEvents,
  quarantinedItems,
  appSettings,
  errorEvents,
} from "@/db/schema.ts";
import { upsertHashtag } from "@/db/repositories/hashtags.ts";
import { ensureTrackedHashtag } from "@/db/repositories/tracking.ts";
import { createCollectionRun } from "@/db/repositories/runs.ts";
import { generateDailyReport } from "@/jobs/generate-daily-report.ts";

export const ADMIN_ID = 999;
export const NORMAL_USER_ID = 111;
export const UNAUTHORIZED_USER_ID = 424242;
export const REPORT_CHAT_ID = 777;

function wrapFixtureAsProvider(id: "apify" | "brightdata", fixture: FixtureProvider): SocialDataProvider {
  return {
    id,
    capabilities: () => fixture.capabilities(),
    submitDiscovery: (input) => fixture.submitDiscovery(input),
    submitRefresh: (input) => fixture.submitRefresh(input),
    getStatus: (externalJobId) => fixture.getStatus(externalJobId),
    fetchResults: (externalJobId) => fixture.fetchResults(externalJobId),
    cancel: (externalJobId) => fixture.cancel(externalJobId),
  };
}

export function buildTestTelegramContext(db: TestDatabase, clock: FixedClock, overrides: Partial<TelegramCommandContext> = {}): TelegramCommandContext & { client: RecordingTelegramClient } {
  const providers: Partial<Record<RuntimeProviderId, SocialDataProvider>> = {
    apify: wrapFixtureAsProvider("apify", new FixtureProvider({ clock, jobs: [] })),
    brightdata: wrapFixtureAsProvider("brightdata", new FixtureProvider({ clock, jobs: [] })),
  };
  const client = createRecordingTelegramClient();
  return {
    db,
    clock,
    market: GLOBAL_MARKET,
    timezone: "UTC",
    auth: { allowedUserIds: new Set([NORMAL_USER_ID]), adminIds: new Set([ADMIN_ID]) },
    reportChatId: REPORT_CHAT_ID,
    providers: new ProviderRegistry(providers, DEFAULT_REGISTRY_CONFIG),
    circuitBreaker: new CircuitBreaker(new DbCircuitBreakerStore(db), clock),
    budgetProfile: "LEAN",
    ...overrides,
    client,
  };
}

let externalIdCounter = 0;
function nextExternalId(): string {
  externalIdCounter += 1;
  return `tg-fixture-${externalIdCounter}`;
}

export async function insertScoredPost(
  db: TestDatabase,
  params: {
    platform: "tiktok" | "instagram";
    creatorUsername: string;
    publishedAt: Date;
    tier: "VIRAL_QUALIFIED" | "EARLY_BREAKOUT" | "WATCH";
    trendScore: number;
    risingScore?: number;
    views: number;
    trendState?: "BREAKOUT" | "RISING" | "ACTIVE" | "STABLE" | "FALLING" | "DEAD" | "NEW";
    hashtagNames?: string[];
    category?: "cosplay" | "streaming" | "gaming" | "pc" | "playstation";
  },
): Promise<number> {
  const externalId = nextExternalId();
  const rows = await db
    .insert(posts)
    .values({
      platform: params.platform,
      externalId,
      market: GLOBAL_MARKET,
      canonicalUrl: `https://www.${params.platform === "tiktok" ? "tiktok.com/@x/video" : "instagram.com/p"}/${externalId}`,
      contentType: "video",
      creatorUsername: params.creatorUsername,
      caption: `a caption about ${params.category ?? "trends"}`,
      publishedAt: params.publishedAt,
      views: params.views,
      likes: Math.round(params.views * 0.05),
      comments: 50,
      shares: 20,
      firstSeenAt: params.publishedAt,
      lastSeenAt: params.publishedAt,
      tier: params.tier,
      availability: "ACTIVE",
      vph: "1000.00",
      vphKind: "OBSERVED",
      velocityConfidence: "HIGH",
      trendScore: params.trendScore,
      risingScore: params.risingScore ?? params.trendScore,
      trendState: params.trendState ?? "ACTIVE",
      scoreComponents: {
        trend: [{ component: "velocity", available: true, raw: 1.5, z: 1.2, normalized: 0.8, weightConfigured: 0.35, weightUsed: 0.35 }],
        rising: [{ component: "velocity", available: true, raw: 1.5, z: 1.2, normalized: 0.8, weightConfigured: 0.5, weightUsed: 0.5 }],
      },
      scoringVersion: 1,
    })
    .returning({ id: posts.id });
  const postId = rows[0]!.id;

  if (params.hashtagNames && params.hashtagNames.length > 0) {
    for (const name of params.hashtagNames) {
      const hashtagId = await upsertHashtag(db, name, params.publishedAt);
      await db.insert(postHashtags).values({ postId, hashtagId }).onConflictDoNothing();
    }
  }
  if (params.category) {
    await db.insert(postCategories).values({ postId, category: params.category, confidence: "0.900", source: "TAG" }).onConflictDoNothing();
  }

  return postId;
}

export async function seedTrackedHashtag(db: TestDatabase, name: string, platform: "tiktok" | "instagram", tier: "CORE" | "ACTIVE" | "EXPLORATION" | "DORMANT", now: Date): Promise<{ hashtagId: number; trackedId: number }> {
  const hashtagId = await upsertHashtag(db, name, now);
  const result = await ensureTrackedHashtag(db, { hashtagId, platform, market: GLOBAL_MARKET, tier, source: "SEED" });
  return { hashtagId, trackedId: result.id };
}

export async function seedCollectionRun(db: TestDatabase, plannedAt: Date, platform: "tiktok" | "instagram", status: "COMPLETED" | "FAILED" | "PARTIAL" = "COMPLETED"): Promise<number> {
  const run = await createCollectionRun(db, { kind: "DISCOVERY", slotKey: `slot-${Math.random()}`, plannedAt });
  await db.insert(providerJobs).values({ collectionRunId: run.id, provider: "apify", platform, jobType: "HASHTAG_DISCOVERY", status: status === "FAILED" ? "FAILED" : "INGESTED", recordsReturned: status === "FAILED" ? 0 : 5, submittedAt: plannedAt });
  return run.id;
}

/** Generates and returns a real frozen DailyReport for `now`/market from
 * whatever posts/collection state already exists in `db` — reuses Phase
 * 7's own orchestrator so the report Telegram commands read is exactly
 * as real as production. */
export async function seedDailyReport(db: TestDatabase, clock: FixedClock, market = GLOBAL_MARKET): Promise<string> {
  const result = await generateDailyReport({ db, clock, market, timezone: "UTC" });
  return result.reportDate;
}

export async function resetTelegramFixtureDb(db: TestDatabase): Promise<void> {
  await db.delete(postDiscoveries);
  await db.delete(postSnapshots);
  await db.delete(postHashtags);
  await db.delete(postCategories);
  await db.delete(quarantinedItems);
  await db.delete(resultViews);
  await db.delete(telegramUpdates);
  await db.delete(dailyReports);
  await db.delete(posts);
  await db.delete(providerJobs);
  await db.delete(collectionRuns);
  await db.delete(hashtagTierEvents);
  await db.delete(trackedHashtags);
  await db.delete(hashtags);
  await db.delete(appSettings);
  await db.delete(errorEvents);
  externalIdCounter = 0;
}
