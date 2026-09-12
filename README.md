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

## Status: Phase 3 complete (database)

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

**Not implemented yet:** production provider API clients/orchestration, collection scheduling,
analytics/scoring, the Telegram bot, and the optional AI layer. See
`docs/IMPLEMENTATION_PLAN.md` §28 for the full phase list — each phase is a separate, reviewable
step.

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

## Project structure

```
src/app/          Next.js App Router — thin HTTP adapters only
src/config/        typed tunables (env, taxonomy, thresholds, scoring, lifecycle, budget, schedule)
src/core/          framework-independent domain logic (no Next/db/Telegram/provider imports)
src/lib/            generic utilities: clock, deadline, errors, logger, exhaustive
src/providers/    normalization (Phase 2, done) + provider API clients (Phase 4)
src/jobs/           collection/report orchestration (Phase 5+)
src/db/              schema, migrations, repositories, seed (Phase 3, done)
src/telegram/     bot commands, rendering, webhook router (Phase 8)
src/insights/      optional OpenRouter integration (Phase 10)
test/unit/          unit tests (pure logic, normalization contract tests against real fixtures)
test/integration/  database integration tests (PGlite)
scripts/             one-off/dev automation (provider spike, db seed)
drizzle/              committed SQL migrations, generated from src/db/schema.ts
docs/                 implementation plan and provider spike findings
```

## Phase progression

See `docs/IMPLEMENTATION_PLAN.md` §28 for full detail on each phase:

0. Bootstrap ✅ → 1/1B. Provider spike ✅ → 2. Domain core & normalization ✅ → 3. Database ✅ →
4. Provider adapters & registry → 5. Collection orchestration → 6. Analytics & lifecycle →
7. Reports, exports, retention → 8. Telegram bot → 9. Production deployment & scheduling →
10. Optional AI (`/ideas`) → 11. Calibration & hardening.
