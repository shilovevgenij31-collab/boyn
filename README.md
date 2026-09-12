# Trend Radar

A Telegram-based trend discovery system for TikTok and Instagram Reels. It continuously
discovers public content around a configurable hashtag taxonomy (cosplay, streaming, gaming, PC,
PlayStation, and hashtags it discovers along the way), detects videos and hashtags that are
growing unusually fast, and delivers a ranked daily report — with direct links to the original
posts — into Telegram. Deterministic backend analytics are the core; an LLM (OpenRouter) is an
optional, non-critical enhancement.

Full architecture, data model, provider research, and the phase-by-phase build plan live in
**[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**.

## Status: Phase 0 (bootstrap)

This repository currently contains the project skeleton only:

- Next.js App Router project, strict TypeScript, ESLint, Prettier, Vitest.
- Environment variable validation (`src/config/env.ts`) covering every variable the full system
  will eventually need — but **nothing is required yet**; Phase 0 boots with no secrets set.
- Core utilities: `Clock`, `Deadline`, `AppError`, structured JSON `logger`, `assertNever`.
- A few domain primitives (`Platform`, `Market`, `Category`) and the seed hashtag taxonomy.
- A single working endpoint: `GET /api/health`.

**Not implemented yet:** social data providers (Bright Data / Apify), the database, the
collection pipeline, analytics/scoring, the Telegram bot, and the optional AI layer. See
`docs/IMPLEMENTATION_PLAN.md` §28 for the full phase list — each phase is a separate, reviewable
step.

## Prerequisites

- Node.js ≥ 22
- npm (this project's package manager)

No database, Telegram bot, or provider account is required to run Phase 0.

## Local setup

```bash
npm install
cp .env.example .env.local   # optional at this phase — every var is optional until its phase
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
npm test                  # vitest run
npm run check           # typecheck + lint + test
```

## Health check

```
GET /api/health
→ { "ok": true, "service": "trend-radar", "version": "...", "uptimeMs": ..., "timestamp": "..." }
```

Process-level only — it does not call the database, Telegram, or any provider.

## Project structure

```
src/app/          Next.js App Router — thin HTTP adapters only
src/config/        typed tunables (env, taxonomy, thresholds, scoring, lifecycle, budget, schedule)
src/core/          framework-independent domain logic (no Next/db/Telegram/provider imports)
src/lib/            generic utilities: clock, deadline, errors, logger, exhaustive
src/providers/    social data provider abstraction (Phase 4)
src/jobs/           collection/report orchestration (Phase 5+)
src/db/              database schema & repositories (Phase 3)
src/telegram/     bot commands, rendering, webhook router (Phase 8)
src/insights/      optional OpenRouter integration (Phase 10)
test/unit/          unit tests
test/integration/  integration tests (Phase 3+)
scripts/             one-off/dev automation (Phase 1+)
docs/                 implementation plan and related docs
```

## Phase progression

See `docs/IMPLEMENTATION_PLAN.md` §28 for full detail on each phase:

0. Bootstrap (this repo) → 1. Provider spike (decision gate) → 2. Domain core & normalization →
3. Database → 4. Provider adapters & registry → 5. Collection orchestration → 6. Analytics &
lifecycle → 7. Reports, exports, retention → 8. Telegram bot → 9. Production deployment &
scheduling → 10. Optional AI (`/ideas`) → 11. Calibration & hardening.
