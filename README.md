# Trend Radar

A Telegram-based trend discovery system for TikTok and Instagram Reels. It continuously
discovers public content around a configurable hashtag taxonomy (cosplay, streaming, gaming, PC,
PlayStation, and hashtags it discovers along the way), detects videos and hashtags that are
growing unusually fast, and delivers a ranked daily report — with direct links to the original
posts — into Telegram. Deterministic backend analytics are the core; an LLM (OpenRouter) is an
optional, non-critical enhancement.

Full architecture, data model, provider research, and the phase-by-phase build plan live in
**[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**. Real provider measurements
(Phase 1/1B) live in **[docs/PROVIDER_SPIKE.md](docs/PROVIDER_SPIKE.md)**.

## Status: Phase 6 complete (analytics & lifecycle)

Phases done so far:

- **Phase 0 — Bootstrap:** Next.js App Router, strict TypeScript, ESLint, Prettier, Vitest.
  Environment validation (`src/config/env.ts`) that boots with zero secrets set. Core utilities:
  `Clock`, `Deadline`, `AppError`, structured JSON `logger`, `assertNever`.
- **Phase 1 / 1B — Provider spike:** real, credentialed measurements against Bright Data and
  Apify (see `docs/PROVIDER_SPIKE.md`) settled provider routing with evidence instead of
  documentation guesses — TikTok discovery = Apify search mode; TikTok fallback = Bright Data
  keyword; Instagram discovery = Apify hashtag mode.
- **Phase 2 — Domain core & normalization:** provider-independent `NormalizedPost` contract
  (`src/core/domain/`) and normalizers for all three supported (provider, platform) combinations
  (`src/providers/{apify,brightdata}/normalize-*.ts`), built and tested against the real
  sanitized fixtures from Phase 1/1B (`test/fixtures/`).
- **Phase 3 — Database:** the full Postgres schema (`src/db/schema.ts`, 21 tables), a committed
  Drizzle migration (`drizzle/`), a typed repository layer (`src/db/repositories/`) covering
  idempotent post upsert/dedup, snapshots, hashtags, tracked-hashtag seeding, and collection-run/
  provider-job persistence, plus a taxonomy seeder (`src/db/seed.ts`). Fully covered by
  integration tests running against PGlite — no Docker, no live database required.
- **Phase 4 — Provider adapters & registry:** production `SocialDataProvider` adapters for Apify
  and Bright Data (`src/providers/{apify,brightdata}/provider.ts`) behind a routing registry with
  primary/fallback selection, a durable circuit breaker, an HTTP retry/backoff layer, and a
  budget ledger computed from persisted `provider_jobs` rows. A deterministic offline
  `FixtureProvider` stands in for real vendors in every test.
- **Phase 5 — Collection orchestration:** a tick-driven, restart-safe state machine
  (`src/jobs/`) that plans discovery/refresh work from `tracked_hashtags`/`posts`, submits it
  through the Phase 4 registry with durable leases (no duplicate work across overlapping ticks),
  polls in-flight provider jobs, and ingests READY results through the Phase 2/3 pipeline —
  quarantining malformed items without losing good ones. Exposed via an authenticated
  `/api/cron/tick` route and an optimization-only `/api/webhooks/[provider]` route; a fully
  offline 3-day simulation (`scripts/simulate.ts`) exercises the whole pipeline with no network
  and no secrets.
- **Phase 6 — Analytics & lifecycle:** deterministic trend intelligence over the Phase 5
  history (`src/core/analytics/`, `src/core/categories/`, `src/core/lifecycle/`, wired together by
  `src/jobs/run-analytics.ts`) — no LLM on the critical path. Observed VPH from real snapshot
  deltas (with a lower-confidence estimated fallback for sparse data), acceleration, robust
  per-platform baselines, `TrendScore`/`RisingScore` (`SCORING_VERSION = 1`) with automatic
  missing-component weight renormalization, post/hashtag trend states, hashtag "Radar Momentum"
  (explicitly scoped to our own monitored sample — never a platform-wide claim), co-occurrence,
  deterministic multi-label categories, and bounded, evidence-driven tracking-tier
  promotion/demotion with tier caps. Analytics-informed refresh prioritization reuses Phase 5's
  own `next_refresh_at` column through a clear boundary. The offline simulation now also runs
  analytics periodically and demonstrates a real lifecycle promotion and demotion from simulated
  evidence.

**Not implemented yet:** the daily report/exports, the Telegram bot, and the optional AI layer.
See `docs/IMPLEMENTATION_PLAN.md` §28 for the full phase list — each phase is a separate,
reviewable step.

## Prerequisites

- Node.js ≥ 22
- npm (this project's package manager)

No database, Telegram bot, or provider account is required to build, lint, or test this repo —
`npm test` runs entirely offline (PGlite for database tests, committed fixtures for provider
normalization tests). A real Postgres connection is only needed to run migrations/seed against
an actual environment (local Neon dev branch, etc.).

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in only what the phase you're working on needs
```

## Running

```bash
npm run dev          # start the Next.js dev server (http://localhost:3000)
npm run build         # production build
npm start              # run a production build
```

## Checks

```bash
npm run typecheck     # tsc --noEmit
npm run lint            # eslint .
npm test                  # vitest run (unit + integration, fully offline)
npm run check           # typecheck + lint + test
```

## Database

Schema lives in `src/db/schema.ts` (Drizzle ORM); migrations are committed SQL under `drizzle/`,
generated from that schema — `db push` is never used as the schema mechanism. Set `DATABASE_URL`
(pooled) and `DATABASE_URL_UNPOOLED` (direct, used by migrations) in `.env.local` before running
these against a real database:

```bash
npm run db:generate   # regenerate drizzle/*.sql after changing src/db/schema.ts
npm run db:migrate     # apply committed migrations to DATABASE_URL_UNPOOLED
npm run db:seed          # idempotently seed the hashtag taxonomy from src/config/taxonomy.ts
```

Integration tests (`test/integration/`) never touch a real database — `createTestDb()`
(`test/integration/helpers/test-db.ts`) boots an in-memory PGlite instance and applies the same
committed migrations, so `npm test` proves the schema and repository layer work without any
external setup.

## Health check

```
GET /api/health
→ { "ok": true, "service": "trend-radar", "version": "...", "uptimeMs": ..., "timestamp": "..." }
```

Process-level only — it does not call the database, Telegram, or any provider. The app boots and
this endpoint works with zero environment variables set, database included.

## Collection tick

`src/jobs/tick.ts`'s `runTick()` is the framework-independent state machine that plans, submits,
polls, and ingests provider work in one bounded pass. It's exposed as:

```
POST /api/cron/tick
Authorization: Bearer <CRON_SECRET>
```

`CRON_SECRET` must be set for the route to run at all — a missing secret fails closed (500), an
incorrect one returns 401. Point an external scheduler (e.g. cron-job.org — wired up in Phase 9,
not here) at this URL roughly every 30 minutes; the tick is safe to call more or less often, and
safe to call concurrently (durable per-job leases prevent overlapping invocations from doing
duplicate work). Locally, once `DATABASE_URL`, `CRON_SECRET`, and at least one provider's
credentials are set in `.env.local`:

```bash
npm run dev
curl -X POST http://localhost:3000/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"
```

`/api/webhooks/[provider]` is a pure optimization (never required for correctness — the tick's
own polling is the source of truth) that nudges a specific job's next poll forward when a
provider calls back with its per-job token; it never trusts a webhook body's claimed status.

## Offline simulation

`scripts/simulate.ts` runs the entire tick pipeline for 3 simulated days — planning, submission,
polling, ingestion, quarantine, refresh, an injected provider failure, and a deliberately delayed
multi-tick job — against PGlite and a deterministic `FixtureProvider`, with an injected `Clock`
standing in for wall-clock time. No network calls, no secrets, safe to run anywhere:

```bash
npm run simulate
```

It prints a JSON summary and exits non-zero if any expected invariant doesn't hold (e.g. no posts
persisted, the injected failure never resolved into a `PARTIAL` run, no lifecycle promotion or
demotion happened). The same engine (`scripts/simulation/engine.ts`) is exercised as a real Vitest
test (`test/integration/simulation.test.ts`), so `npm test` also proves it — the CLI is just a
convenient way to read the summary directly. It now runs 5 simulated days (not just 3) and
periodically invokes `runAnalytics()` alongside the tick pipeline.

## Analytics (Phase 6)

`src/jobs/run-analytics.ts` turns collected history into deterministic trend intelligence — no
LLM on the critical path. Key decisions, all versioned as `SCORING_VERSION = 1`
(`src/config/scoring.ts`) — a reasoned, deterministic starting point, **not yet empirically
calibrated**; Phase 11 recalibrates weights/thresholds after real production data accumulates:

- **Observed vs. estimated VPH** (`src/core/analytics/velocity.ts`): views-per-hour computed from
  real consecutive snapshots is `OBSERVED` (`MEDIUM`/`HIGH` confidence by how many real intervals
  exist); with only a lifetime-average interval available it's a lower-confidence `ESTIMATED`
  fallback — the two are never presented as equivalent.
- **`TrendScore`** (velocity .35 / reach .20 / engagement .15 / freshness .15 / hashtag momentum
  .10 / acceleration .05) and **`RisingScore`** (velocity .50 / acceleration .20 / freshness .20 /
  engagement .10) share one generic rule (`src/core/analytics/weighting.ts`): a missing component
  is dropped and the remaining weights renormalize — never treated as a 0.
- **Tracking tier vs. trend state** — two different concepts that are never merged: tracking tier
  (`CORE`/`ACTIVE`/`EXPLORATION`/`DORMANT`, `src/core/lifecycle/`) is how much crawl budget a
  hashtag gets; trend state (`BREAKOUT`/`RISING`/`ACTIVE`/`STABLE`/`FALLING`/`DEAD`/`NEW`) is what
  a post or hashtag is doing right now. Both persist to the same `trend_state` Postgres enum, on
  different tables/columns, computed independently.
- **"Radar Momentum" wording** (CLAUDE.md rule 13 / ADR-022): hashtag growth is measured only
  inside our own bounded, budgeted sample of tracked tags. Field/function names stay plain
  (`momentum`, `computeHashtagMomentum`), but any user-facing copy built from them must say "Radar
  momentum" / "growth in our monitored sample" — never a platform-wide claim.

## Project structure

```
src/app/          Next.js App Router — thin HTTP adapters only
src/config/        typed tunables (env, taxonomy, thresholds, scoring, lifecycle, budget, schedule)
src/core/          framework-independent domain logic (no Next/db/Telegram/provider imports):
                       domain/scheduling (Phase 5), analytics/categories/lifecycle (Phase 6)
src/lib/            generic utilities: clock, deadline, errors, logger, exhaustive
src/providers/    normalization (Phase 2) + production provider adapters/registry (Phase 4)
src/jobs/           tick-driven collection: plan/submit/poll/ingest (Phase 5) + run-analytics (Phase 6)
src/db/              schema, migrations, repositories, seed (Phase 3, done)
src/telegram/     bot commands, rendering, webhook router (Phase 8)
src/insights/      optional OpenRouter integration (Phase 10)
test/unit/          unit tests (pure logic, normalization contract tests against real fixtures)
test/integration/  database integration tests (PGlite) + the offline tick/simulation suite
scripts/             one-off/dev automation (provider spike, db seed, provider smoke, simulation)
drizzle/              committed SQL migrations, generated from src/db/schema.ts
docs/                 implementation plan and provider spike findings
```

## Phase progression

See `docs/IMPLEMENTATION_PLAN.md` §28 for full detail on each phase:

0. Bootstrap ✅ → 1/1B. Provider spike ✅ → 2. Domain core & normalization ✅ → 3. Database ✅ →
4. Provider adapters & registry ✅ → 5. Collection orchestration ✅ → 6. Analytics & lifecycle ✅ →
7. Reports, exports, retention → 8. Telegram bot → 9. Production deployment & scheduling →
10. Optional AI (`/ideas`) → 11. Calibration & hardening.
